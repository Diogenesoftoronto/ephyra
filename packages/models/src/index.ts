import { z } from "zod";
import { ExtractionResponse, Unverified, type ExtractBackend, type DecideBackend, type ExtractionRequest } from "@ephyra/core";

export const Purpose = z.enum(["extract", "decide.triage", "decide.policy", "decide.watch"]);
export type Purpose = z.infer<typeof Purpose>;
export const BackendConfig = z.object({
  kind: z.string().regex(/^(notorganic|byok:.+|selfhosted:.+)$/), alias: z.string().min(1),
  endpoint: z.url(), credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  supports: z.array(z.enum(["noul", "choice", "score"])),
  pricing: z.record(z.string(), z.number().nonnegative()).optional(),
});
export const RegistryConfig = z.object({ backends: z.array(BackendConfig), purposes: z.partialRecord(Purpose, z.string()) }).superRefine((config, ctx) => {
  const names = new Set<string>();
  for (const backend of config.backends) {
    if (names.has(backend.alias)) ctx.addIssue({ code: "custom", message: `duplicate alias: ${backend.alias}` });
    names.add(backend.alias);
  }
});
export type RegistryConfig = z.infer<typeof RegistryConfig>;
export class UnknownAlias extends Error {
  constructor(public readonly alias: string) { super(`Unknown backend alias: ${alias}`); this.name = "UnknownAlias"; }
}
export class Registry {
  readonly config: RegistryConfig;
  constructor(config: unknown, private readonly instances: ReadonlyMap<string, DecideBackend | ExtractBackend>) { this.config = RegistryConfig.parse(config); }
  resolve(purpose: Purpose): DecideBackend | ExtractBackend {
    const alias = this.config.purposes[purpose];
    if (!alias) throw new UnknownAlias(purpose);
    const configured = this.config.backends.find((backend) => backend.alias === alias);
    const backend = this.instances.get(alias);
    if (!configured || !backend) throw new UnknownAlias(alias);
    if (backend.kind !== configured.kind || backend.alias !== alias || (purpose === "extract" ? !("extract" in backend) : !("decide" in backend))) throw new Error(`Backend does not match registry: ${alias}`);
    return backend;
  }
}
export interface AccessTokenProvider { getAccessToken(): Promise<string> }
export function defaultAccessTokenProvider(): AccessTokenProvider { throw new Unverified("notorganic product registration"); }

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
      if (name === "exception_type" && exception) matches = [{ value: exception[0], span: [exception.index, exception.index + exception[0].length] }];
      if (name === "top_app_frame" && app) { const i = app.index! + app[0].indexOf(app[1]!); matches = [{ value: app[1]!, span: [i, i + app[1]!.length] }]; }
      if (name === "touched_files") matches = frames.map(m => { const i = m.index! + m[0].indexOf(m[1]!); return { value: m[1]!, span: [i, i + m[1]!.length] }; });
      answers[name] = field.type === "list" ? { type: field.type, value: matches.map(m => m.value), spans: matches.map(m => m.span) } : { type: field.type, value: matches[0]?.value ?? null, ...(matches[0] ? { span: matches[0].span } : {}) };
    }
    return ExtractionResponse.parse({ model: "parser/regex", answers });
  }
}
