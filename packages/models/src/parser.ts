import { ExtractionResponse, type ExtractBackend, type ExtractionRequest } from "@ephyra/core";

/** Deterministic extraction only; missing values have no confidence score. */
export class ParserExtract implements ExtractBackend {
  readonly kind = "parser" as const;
  constructor(readonly alias = "parser") {}
  async extract(req: ExtractionRequest, _opts: { idempotencyKey: string; signal?: AbortSignal }): Promise<ExtractionResponse> {
    const text = req.state;
    const exception = /\b(?:[A-Za-z_][\w.]*?(?:Error|Exception|Panic| panic))\b/.exec(text);
    const frame = /(?:\bat\s+(?:[^\n(]*\()?|File\s+["'])([^\s()"']+\.(?:[cm]?[jt]sx?|py|rs))(?::\d+(?::\d+)?|["'], line \d+)/g;
    const frames = [...text.matchAll(frame)];
    const app = frames.find(m => !/node_modules|\/lib\/python|\/rustc\//.test(m[1]!));
    const answers: ExtractionResponse["answers"] = {};
    for (const [name, field] of Object.entries(req.fields)) {
      let matches: Array<{ value: string; span: [number, number] }> = [];
      if (name === "exception_type" && exception) {
        matches = [{ value: exception[0], span: [exception.index, exception.index + exception[0].length] }];
      }
      if (name === "top_app_frame" && app) {
        const i = app.index! + app[0].indexOf(app[1]!);
        matches = [{ value: app[1]!, span: [i, i + app[1]!.length] }];
      }
      if (name === "touched_files") matches = frames.map(m => {
        const i = m.index! + m[0].indexOf(m[1]!);
        return { value: m[1]!, span: [i, i + m[1]!.length] };
      });
      answers[name] = field.type === "list"
        ? { type: field.type, value: matches.map(m => m.value), spans: matches.map(m => m.span) }
        : { type: field.type, value: matches[0]?.value ?? null, ...(matches[0] ? { span: matches[0].span } : {}) };
    }
    return ExtractionResponse.parse({ model: "parser/regex", answers });
  }
}
