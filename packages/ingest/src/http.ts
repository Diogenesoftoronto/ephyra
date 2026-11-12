import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import type { Signal, SignalStore } from "@ephyra/core";
import { parseOtlp } from "./otlp.ts";
import { decodeOtlpProtobuf, encodeOtlpError, encodeOtlpResponse } from "./protobuf.ts";

export type OtlpOptions = {
  store: SignalStore;
  onNewSignal: (signal: Signal) => void | Promise<void>;
  quota: (key: string) => boolean | Promise<boolean>;
  maxBodyBytes: number;
  gapMs?: number;
};
async function readBounded(
  request: Request,
  limit: number,
): Promise<Uint8Array | null> {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(limit))
    return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export function otlpRoutes(options: OtlpOptions): Hono {
  if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1)
    throw new Error("OTLP maxBodyBytes must be a positive integer");
  const app = new Hono();
  const completed = new Set<string>();
  const suppressed = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  for (const kind of ["logs", "traces"] as const) {
    app.post(`/v1/${kind}`, async (c) => {
      const contentType = c.req
        .header("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      const binary = contentType === "application/x-protobuf";
      if (contentType !== "application/json" && !binary)
        return c.json(
          { error: "Use application/json or application/x-protobuf" },
          415,
        );
      const failure = (message: string, status: 400 | 413 | 415 | 429, code = 3) => binary
        ? new Response(new Uint8Array(encodeOtlpError(code, message)).buffer, { status, headers: { "content-type": "application/x-protobuf" } })
        : c.json({ code, message }, status);
      const encoding = c.req.header("content-encoding")?.trim().toLowerCase();
      if (encoding && encoding !== "identity" && encoding !== "gzip")
        return failure("Unsupported content encoding", 415, 12);
      const key = c.req.header("authorization") ?? "anonymous";
      if (!(await options.quota(key)))
        return failure("quota exceeded", 429, 8);
      let bytes = await readBounded(c.req.raw, options.maxBodyBytes);
      if (bytes === null) return failure("body too large", 413, 8);
      if (encoding === "gzip") {
        try { bytes = new Uint8Array(gunzipSync(bytes, { maxOutputLength: options.maxBodyBytes })); }
        catch (error) {
          if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") return failure("body too large", 413, 8);
          return failure("invalid gzip body", 400);
        }
      }
      let parsed: ReturnType<typeof parseOtlp>;
      try {
        parsed = parseOtlp(binary ? decodeOtlpProtobuf(bytes, kind)
          : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), kind);
      } catch {
        return failure(binary ? "invalid OTLP protobuf" : "invalid OTLP JSON", 400);
      }
      const digest = createHash("sha256")
        .update(kind)
        .update(key)
        .update(bytes)
        .digest("hex");
      const run = async () => {
        if (completed.has(digest)) return;
        for (const request of parsed.requests) {
          const store = options.store as SignalStore & {
            recordRequest?: (route: string, at: Date, error: boolean) => void | Promise<void>;
          };
          await store.recordRequest?.(request.route, request.at, request.error);
        }
        for (const signal of parsed.signals) {
          const previous = await options.store.byFingerprint(
            signal.fingerprint,
          );
          const result = await options.store.upsert(signal);
          const gap =
            previous &&
            Date.parse(signal.firstSeen) - Date.parse(previous.lastSeen) >=
              (options.gapMs ?? 3600000);
          const muted = await options.store.isMuted(
            signal.fingerprint,
            new Date(signal.firstSeen),
          );
          if (muted) suppressed.add(signal.fingerprint);
          else if (result.isNew || gap || suppressed.has(signal.fingerprint)) {
            await options.onNewSignal(result.signal);
            suppressed.delete(signal.fingerprint);
          }
        }
        completed.add(digest);
      };
      let task = pending.get(digest);
      if (!task) {
        task = run();
        pending.set(digest, task);
      }
      try {
        await task;
      } finally {
        pending.delete(digest);
      }
      if (binary) return new Response(new Uint8Array(encodeOtlpResponse(parsed.rejected)).buffer, {
        headers: { "content-type": "application/x-protobuf" },
      });
      return c.json({
        partialSuccess: {
          [kind === "logs" ? "rejectedLogRecords" : "rejectedSpans"]:
            parsed.rejected,
          errorMessage: parsed.rejected ? "Some records were rejected" : "",
        },
      });
    });
  }
  return app;
}
