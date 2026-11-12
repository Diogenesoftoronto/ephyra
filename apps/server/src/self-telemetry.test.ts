import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Unverified } from "@ephyra/core";
import { parseOtlp } from "@ephyra/ingest";
import { SelfReporter, verifyWorkspaceIngestToken, workspaceIngestToken } from "./self-telemetry";

const KEY = Buffer.alloc(32, 7).toString("base64");
const WS = `ws_${"a".repeat(40)}`;
const SECRET = "super-secret-provider-key-123";

function reporter(overrides: Partial<ConstructorParameters<typeof SelfReporter>[0]> = {}) {
  const sent: unknown[] = [];
  let now = 1_800_000_000_000;
  const r = new SelfReporter({
    endpoint: `http://127.0.0.1:9/otlp/workspaces/${WS}/v1/logs`, token: workspaceIngestToken(KEY, WS),
    service: "ephyra-server", environment: "production", version: "test", sourceRoot: "/app", secrets: [SECRET],
    fetch: (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("{}"); }) as typeof fetch,
    now: () => now, ...overrides,
  });
  return { r, sent, advance: (ms: number) => { now += ms; } };
}

describe("workspace ingest tokens", () => {
  test("a token opens only its own workspace, and only with the key that made it", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-f0-9]{40}$/), fc.stringMatching(/^[a-f0-9]{40}$/), (a, b) => {
      const token = workspaceIngestToken(KEY, `ws_${a}`);
      expect(verifyWorkspaceIngestToken(KEY, `ws_${a}`, `Bearer ${token}`)).toBe(true);
      expect(verifyWorkspaceIngestToken(KEY, `ws_${b}`, `Bearer ${token}`)).toBe(a === b);
      expect(verifyWorkspaceIngestToken(Buffer.alloc(32, 8).toString("base64"), `ws_${a}`, `Bearer ${token}`)).toBe(false);
    }));
  });

  test("missing, malformed and truncated credentials are refused", () => {
    const token = workspaceIngestToken(KEY, WS);
    for (const header of [undefined, "", token, `Basic ${token}`, `Bearer ${token.slice(0, -1)}`, `Bearer ${token}x`, "Bearer "])
      expect(verifyWorkspaceIngestToken(KEY, WS, header)).toBe(false);
  });
});

describe("self reporter", () => {
  test("a report is OTLP the intake parses into one signal with repository-relative frames and no secret", async () => {
    const { r, sent } = reporter();
    const error = new TypeError(`provider said ${SECRET}`);
    error.stack = `TypeError: provider said ${SECRET}\n    at intake (/app/apps/server/src/wiring/intake.ts:58:9)\n`
      + "    at run (/app/node_modules/hono/dist/hono.js:1:1)";
    r.report({ error, source: "job:triage", route: "/v1/trails" });
    await r.flush();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain(SECRET);
    const [signal] = parseOtlp(sent[0], "logs").signals;
    expect(signal?.service).toBe("ephyra-server");
    expect(signal?.environment).toBe("production");
    expect(signal?.exceptionType).toBe("TypeError");
    expect(signal?.frames[0]).toMatchObject({ file: "apps/server/src/wiring/intake.ts", line: 58, inApp: true });
    expect(signal?.frames[1]?.inApp).toBe(false);
  });

  test("designed outcomes, client errors and failures inside the intake are never reported", () => {
    const { r } = reporter();
    const client = Object.assign(new Error("bad input"), { status: 400 });
    expect(r.admit({ error: new Unverified("posthog coverage"), source: "job:x" })).toBe(false);
    expect(r.admit({ error: client, source: "http" })).toBe(false);
    expect(r.admit({ error: new Error("boom"), source: "http", route: "/otlp/workspaces/:workspace/v1/:kind" })).toBe(false);
    expect(r.admit({ error: Object.assign(new Error("down"), { status: 503 }), source: "http" })).toBe(true);
  });

  test("the same error is reported once per window, and no more than the rate limit in any minute", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 5_000 })), { maxLength: 200 }),
      (events) => {
        const { r, advance } = reporter({ dedupeMs: 60_000, maxPerMinute: 5 });
        const admitted: { at: number; id: number }[] = [];
        let at = 0;
        for (const [id, gap] of events) {
          advance(gap); at += gap;
          if (r.admit({ error: new Error(`fault ${id}`), source: "job:x" })) admitted.push({ at, id });
        }
        for (const [i, a] of admitted.entries()) {
          expect(admitted.slice(0, i).some((b) => b.id === a.id && a.at - b.at < 60_000)).toBe(false);
        }
        // Windows are fixed minutes from the first admission, so at most 5 per window.
        expect(admitted.length).toBeLessThanOrEqual(5 * (Math.floor(at / 60_000) + 2));
      }));
  });

  test("a failing intake is swallowed, never reported about itself", async () => {
    let calls = 0;
    const { r } = reporter({ fetch: (async () => { calls++; throw new Error("connection refused"); }) as unknown as typeof fetch });
    r.report({ error: new Error("first"), source: "http" });
    await r.flush();
    expect(calls).toBe(1);
  });

  test("a remote endpoint must be HTTPS and must not carry credentials", () => {
    expect(() => reporter({ endpoint: "http://example.com/otlp/v1/logs" })).toThrow();
    expect(() => reporter({ endpoint: "https://user:pass@example.com/otlp/v1/logs" })).toThrow();
    expect(() => reporter({ endpoint: "https://example.com/otlp/v1/logs" })).not.toThrow();
  });
});

describe("intake receipts", () => {
  test("setup counts the intake as live only while a receipt is fresh, and a missing or bad receipt never counts", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { intakeFresh, recordIntake, INTAKE_FRESH_MS } = await import("./self-telemetry");
    const dir = await mkdtemp(join(tmpdir(), "ephyra-intake-"));
    expect(await intakeFresh(dir)).toBe(false);
    const at = new Date("2026-11-12T00:00:00Z");
    await recordIntake(dir, at);
    expect(await intakeFresh(dir, at.getTime() + 1000)).toBe(true);
    expect(await intakeFresh(dir, at.getTime() + INTAKE_FRESH_MS + 1)).toBe(false);
    expect(await intakeFresh(dir, at.getTime() - 3_600_000)).toBe(false);
    await writeFile(join(dir, "otlp-intake.json"), "{not json");
    expect(await intakeFresh(dir)).toBe(false);
  });
});
