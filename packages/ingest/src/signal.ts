import { Signal as SignalSchema, uuidv7, type Signal } from "@ephyra/core";
import { fingerprint, type Signalish } from "./fingerprint.ts";
import { redact } from "./redact.ts";
export function toSignal(
  input: Signalish & {
    repo: string;
    environment?: string;
    service?: string;
    route?: string;
    traceId?: string;
    spanId?: string;
    at?: string;
    attributes?: Record<string, string>;
  },
): Signal {
  const frames = (input.frames ?? []).map((f) => ({
    ...f,
    file: redact(f.file),
    fn: f.fn ? redact(f.fn) : undefined,
  }));
  const message = redact(input.message ?? "Error").slice(0, 8000),
    exceptionType = input.exceptionType && redact(input.exceptionType);
  const at = input.at ?? new Date().toISOString();
  return SignalSchema.parse({
    schema: 1,
    id: uuidv7(),
    kind: "error",
    repo: redact(input.repo),
    environment: redact(input.environment ?? "production"),
    service: input.service && redact(input.service),
    route: input.route && redact(input.route),
    fingerprint: fingerprint({ message, exceptionType, frames }),
    title: (exceptionType || message).slice(0, 300),
    message,
    exceptionType,
    frames,
    traceId: input.traceId,
    spanId: input.spanId,
    firstSeen: at,
    lastSeen: at,
    count: 1,
    attributes: Object.fromEntries(
      Object.entries(input.attributes ?? {}).map(([k, v]) => [
        redact(k),
        redact(v),
      ]),
    ),
    source: "otlp",
  });
}
