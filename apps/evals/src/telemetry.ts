import { context, trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { redact } from "@ephyra/agent";
export function secrets(): string[] {
  return Object.entries(process.env)
    .filter(([k, v]) => v && /(KEY|TOKEN|SECRET|PASSWORD)/i.test(k))
    .map(([, v]) => v!);
}
export function clean(value: unknown): string {
  return redact(typeof value === "string" ? value : JSON.stringify(value), secrets(), 100_000);
}
export class Telemetry {
  readonly memory = new InMemorySpanExporter();
  readonly provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "ephyra-evals", model_id: "ephyra-evals" }),
    spanProcessors: [new SimpleSpanProcessor(this.memory)],
  });
  readonly tracer = this.provider.getTracer("ephyra-evals", "1");
  async span<T>(
    kind: "CHAIN" | "LLM" | "AGENT" | "TOOL",
    name: string,
    input: unknown,
    parent: Span | undefined,
    work: (span: Span) => Promise<T>,
  ): Promise<T> {
    const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
    const span = this.tracer.startSpan(
      name,
      {
        attributes: {
          "openinference.span.kind": kind,
          "input.value": clean(input),
          "input.mime_type": "application/json",
        },
      },
      ctx,
    );
    try {
      const result = await work(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: clean(String(e)) });
      throw e;
    } finally {
      span.end();
    }
  }
}
