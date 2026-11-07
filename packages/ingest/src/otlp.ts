import type { Signal } from "@ephyra/core";
import { parseStack } from "./stack.ts";
import { toSignal } from "./signal.ts";

type Obj = Record<string, any>;
export type OtlpResult = {
  signals: Signal[];
  requests: { route: string; at: Date; error: boolean }[];
  rejected: number;
};

function attrs(values: unknown): Record<string, string> {
  if (!Array.isArray(values)) return {};
  return Object.fromEntries(
    values
      .filter((v) => v && typeof v.key === "string")
      .map((v) => {
        const value = v.value ?? {};
        return [
          v.key,
          String(
            value.stringValue ??
              value.intValue ??
              value.doubleValue ??
              value.boolValue ??
              "",
          ),
        ];
      }),
  );
}
function timestamp(value: unknown): string {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const date = new Date(Number(BigInt(value) / 1000000n));
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return new Date().toISOString();
}
function signal(
  resource: Record<string, string>,
  attributes: Record<string, string>,
  data: Obj,
): Signal {
  const stack = attributes["exception.stacktrace"] ?? "";
  return toSignal({
    repo: resource["service.name"] || "unknown",
    service: resource["service.name"],
    environment: resource["deployment.environment.name"],
    route: data.route,
    traceId: data.traceId,
    spanId: data.spanId,
    at: timestamp(data.time),
    exceptionType: attributes["exception.type"],
    message: attributes["exception.message"] || data.message || "Error",
    frames: parseStack(stack),
    attributes,
  });
}
export function parseOtlp(body: unknown, kind: "logs" | "traces"): OtlpResult {
  const result: OtlpResult = { signals: [], requests: [], rejected: 0 };
  if (!body || typeof body !== "object") throw new Error("Invalid OTLP JSON");
  const groups = (body as Obj)[
    kind === "logs" ? "resourceLogs" : "resourceSpans"
  ];
  if (groups === undefined) return result;
  if (!Array.isArray(groups)) throw new Error("Invalid resource groups");
  for (const group of groups) {
    const resource = attrs(group?.resource?.attributes);
    const scopes = group?.[kind === "logs" ? "scopeLogs" : "scopeSpans"] ?? [];
    if (!Array.isArray(scopes)) {
      result.rejected++;
      continue;
    }
    for (const scope of scopes) {
      const records = scope?.[kind === "logs" ? "logRecords" : "spans"] ?? [];
      if (!Array.isArray(records)) {
        result.rejected++;
        continue;
      }
      for (const record of records) {
        try {
          if (!record || typeof record !== "object")
            throw new Error("Invalid record");
          const a = attrs(record.attributes);
          if (kind === "logs") {
            if (
              Number(record.severityNumber) >= 17 ||
              Object.keys(a).some((k) => k.startsWith("exception."))
            ) {
              result.signals.push(
                signal(resource, a, {
                  ...record,
                  time: record.timeUnixNano,
                  route: a["http.route"] ?? a["url.template"],
                  message: record.body?.stringValue,
                }),
              );
            }
          } else {
            const route = a["http.route"] ?? a["url.template"] ?? record.name;
            const events = Array.isArray(record.events)
              ? record.events.filter((e: Obj) => e.name === "exception")
              : [];
            const error =
              record.status?.code === 2 ||
              record.status?.code === "STATUS_CODE_ERROR";
            if (
              route &&
              (record.kind === 2 || record.kind === "SPAN_KIND_SERVER")
            ) {
              result.requests.push({
                route,
                at: new Date(timestamp(record.startTimeUnixNano)),
                error,
              });
            }
            for (const event of events)
              result.signals.push(
                signal(
                  resource,
                  { ...a, ...attrs(event.attributes) },
                  {
                    ...record,
                    route,
                    time: event.timeUnixNano ?? record.startTimeUnixNano,
                  },
                ),
              );
            if (error && events.length === 0)
              result.signals.push(
                signal(resource, a, {
                  ...record,
                  route,
                  time: record.startTimeUnixNano,
                  message: record.status?.message,
                }),
              );
          }
        } catch {
          result.rejected++;
        }
      }
    }
  }
  return result;
}
