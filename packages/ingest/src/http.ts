import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Signal, SignalStore } from "@ephyra/core";
import { parseOtlp } from "./otlp.ts";

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
      if (contentType !== "application/json")
        return c.json(
          { error: "JSON required; protobuf support is planned" },
          415,
        );
      const key = c.req.header("authorization") ?? "anonymous";
      if (!(await options.quota(key)))
        return c.json({ error: "quota exceeded" }, 429);
      const bytes = await readBounded(c.req.raw, options.maxBodyBytes);
      if (bytes === null) return c.json({ error: "body too large" }, 413);
      let parsed: ReturnType<typeof parseOtlp>;
      try {
        parsed = parseOtlp(JSON.parse(new TextDecoder().decode(bytes)), kind);
      } catch {
        return c.json({ error: "invalid OTLP JSON" }, 400);
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
