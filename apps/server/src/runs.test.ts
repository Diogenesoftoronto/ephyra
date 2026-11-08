import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Hono } from "hono";
import { AgentRun, AgentRunEvent } from "@ephyra/core";
import { createApp } from "./http/app.ts";
import { consoleRoutes } from "./http/console.ts";
import { MemoryUsageStore } from "./usage.ts";
import { MemoryRunStore, RunBroker, RunRecorder, runEventBatches, type RunStore } from "./runs.ts";

const TOKEN = "t".repeat(32);
const H = { Authorization: `Bearer ${TOKEN}`, "X-Ephyra-Principal": "plugin" };
const TRAIL = "01a1b539-866f-77a3-833f-b417d7707bbd";
const start = (id: string, over: Partial<AgentRun> = {}) => ({
  id, trailId: TRAIL, short: "T-07bbd0", step: "research", persona: "bell" as const, engine: "amp/medium", executor: { kind: "orb" as const,
    project: "dio/shop" }, ...over,
});

function harness(store: RunStore = new MemoryRunStore()) {
  const broker = new RunBroker();
  let t = Date.parse("2026-11-07T10:00:00Z");
  const now = () => new Date((t += 1000));
  const recorder = new RunRecorder(store, broker, () => undefined, now);
  const port = {
    usage: new MemoryUsageStore(), trails: async () => [], activity: async () => [], docs: {} as never, drafts: {} as never, runs: store, broker, now,
  };
  const app = createApp(TOKEN, {} as never, new Hono(), undefined, { requireSignIn: false, approvers: new Set() }, (a) => consoleRoutes(port, a));
  return { store, broker, recorder, app, get: (p: string, h: Record<string, string> = {}) => app.request(p, { headers: { ...H, ...h } }) };
}

/** Reads SSE frames from a response until the stream ends (or `max` frames). */
async function frames(res: Response, max = 1000): Promise<{ id?: string; event?: string; data?: string }[]> {
  const out: { id?: string; event?: string; data?: string }[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (out.length < max) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (raw.startsWith(":") || raw.startsWith("retry:")) continue;
      const f: Record<string, string> = {};
      for (const line of raw.split("\n")) { const k = line.indexOf(": "); f[line.slice(0, k)] = line.slice(k + 2); }
      out.push(f);
    }
  }
  await reader.cancel().catch(() => undefined);
  return out;
}

describe("RunStore", () => {
  test("events get monotonic seq per run, in append order, and `after` resumes", () => {
    fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 8 }), async (batches) => {
      const store = new MemoryRunStore();
      await store.create(AgentRun.parse({ ...start("r"), status: "running", startedAt: "2026-11-07T10:00:00.000Z" }));
      let n = 0;
      for (const size of batches) {
        const stored = await store.append("r", Array.from({ length: size }, () => ({ at: "2026-11-07T10:00:00.000Z", type: "message" as const,
          text: String(n++) })));
        expect(stored.map((e) => e.seq)).toEqual(Array.from({ length: size }, (_, i) => n - size + i));
      }
      const all = await store.events("r", undefined, 1000);
      expect(all.map((e) => e.seq)).toEqual(Array.from({ length: n }, (_, i) => i));
      const k = Math.floor(n / 2);
      expect((await store.events("r", k, 1000)).map((e) => e.seq)).toEqual(all.slice(k + 1).map((e) => e.seq));
    }), { numRuns: 30 });
  });
  test("list puts running first then newest, filters by trail id or short and status; create is idempotent", async () => {
    const h = harness();
    const a = await h.recorder.start(start("a"));
    const b = await h.recorder.start(start("b", { trailId: "11111111-1111-4111-8111-111111111111", short: "T-other" }));
    await a.finish({ status: "done" });
    const c = await h.recorder.start(start("c"));
    expect((await h.store.list({ limit: 10 })).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect((await h.store.list({ limit: 10, trail: "T-07bbd0" })).map((r) => r.id)).toEqual(["c", "a"]);
    expect((await h.store.list({ limit: 10, trail: TRAIL, status: "done" })).map((r) => r.id)).toEqual(["a"]);
    await h.store.create(AgentRun.parse({ ...start("a"), status: "failed", startedAt: "2020-01-01T00:00:00.000Z" }));
    expect((await h.store.get("a"))!.status).toBe("done");
    expect(await h.store.closeRunning("restart", new Date("2026-11-07T11:00:00Z"))).toBe(2);
    expect((await h.store.get("b"))).toMatchObject({ status: "failed", error: "restart" });
    void b; void c;
  });
});

describe("RunRecorder", () => {
  test("large visual records stay intact across bounded storage batches", () => {
    const events = Array.from({ length: 7 }, (_, index) => ({ type: "message" as const, at: "2026-11-08T01:00:00.000Z",
      visual: { id: `v${index}`, title: "Inspect", html: "界".repeat(200000), height: 420 } }));
    const batches = runEventBatches(events);
    expect(batches.flat()).toEqual(events);
    expect(batches).toHaveLength(7);
    for (const batch of batches) {
      const bytes = new TextEncoder().encode(JSON.stringify(batch.map((event) => JSON.stringify(event))));
      expect(bytes.byteLength).toBeLessThan(800000);
    }
  });

  test("live metadata arrives before completion; saved visuals replay through the authorized API", async () => {
    const h = harness();
    const run = await h.recorder.start(start("visual-live"));
    const response = await h.get("/v1/runs/visual-live/events", { Accept: "text/event-stream" });
    const pending = frames(response, 2);
    const threadUrl = "https://ampcode.com/threads/T-01a1b539-f083-765f-8b6b-9255cfec4fb5";
    run.executor({ threadUrl });
    const states = (await pending).filter((frame) => frame.event === "run_state").map((frame) => JSON.parse(frame.data!));
    expect(states.at(-1)).toMatchObject({ status: "running", executor: { threadUrl } });
    const visual = { id: "v", title: "Inspect", html: "<button>Inspect</button>", height: 420 };
    await run.event({ type: "message", visual });
    await run.finish({ status: "done" });
    const replay = await (await h.get("/v1/runs/visual-live/events")).json() as AgentRunEvent[];
    expect(replay[0]?.visual).toEqual(visual);
    expect((await h.app.request("/v1/runs/visual-live/events")).status).toBe(401);
  });

  test("buffers, stamps seq, merges executor details, closes with usage and a redacted error", async () => {
    const h = harness();
    const run = await h.recorder.start(start("r1"));
    for (let i = 0; i < 25; i++) await run.event({ type: "message", text: `m${i}` });
    run.executor({ threadUrl: "https://ampcode.com/threads/T-01a1b539-f083-765f-8b6b-9255cfec4fb5" });
    run.executor({ portalUrl: "https://3000-x.portal.example.test/" });
    await run.finish({ status: "failed", engine: "amp/high", usage: { tokens: 5, costMicrousd: null }, error: "boom Authorization: Bearer abcdef123456789" });
    const stored = (await h.store.get("r1"))!;
    expect(stored).toMatchObject({ status: "failed", engine: "amp/high", usage: { tokens: 5, costMicrousd: null } });
    expect(stored.executor).toEqual({
      kind: "orb", project: "dio/shop", threadUrl: "https://ampcode.com/threads/T-01a1b539-f083-765f-8b6b-9255cfec4fb5", portalUrl: "https://3000-x.portal.example.test/",
    });
    expect(stored.error).not.toContain("abcdef123456789");
    expect(stored.endedAt).toBeTruthy();
    const events = await h.store.events("r1", undefined, 100);
    expect(events.map((e) => e.text)).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
  test("a failing store never throws into the step; an invalid event is dropped", async () => {
    const logs: string[] = [];
    const broken: RunStore = { ...new MemoryRunStore(), create: async () => { throw new Error("down"); }, put: async () => { throw new Error("down"); },
      append: async () => { throw new Error("down"); } } as never;
    const rec = new RunRecorder(broken, new RunBroker(), (m) => logs.push(m));
    const run = await rec.start(start("r"));
    await run.event({ type: "message", text: "x" });
    await run.event({ type: "portal", portalUrl: "not a url" });
    await run.finish({ status: "done" });
    expect(logs).toContain("run create failed");
    expect(logs).toContain("run event dropped (invalid)");
  });
});

describe("routes", () => {
  test("list, get, JSON events with ?after, filters and validation", async () => {
    const h = harness();
    const run = await h.recorder.start(start("r1"));
    await run.event({ type: "message", text: "one" });
    await run.event({ type: "reasoning", text: "two" });
    await run.event({ type: "tool_call", tool: { callId: "c", name: "shell_command", args: "{}" } });
    await run.finish({ status: "done" });
    expect(((await (await h.get("/v1/runs")).json()) as AgentRun[]).map((r) => r.id)).toEqual(["r1"]);
    expect(((await (await h.get("/v1/runs?status=running")).json()) as AgentRun[])).toEqual([]);
    expect((await h.get("/v1/runs?status=sleeping")).status).toBe(400);
    expect((await h.get("/v1/runs?limit=0")).status).toBe(400);
    expect(AgentRun.parse(await (await h.get("/v1/runs/r1")).json()).id).toBe("r1");
    expect((await h.get("/v1/runs/nope")).status).toBe(404);
    const all = await (await h.get("/v1/runs/r1/events")).json() as AgentRunEvent[];
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(((await (await h.get("/v1/runs/r1/events?after=0")).json()) as AgentRunEvent[]).map((e) => e.seq)).toEqual([1, 2]);
    expect(((await (await h.get("/v1/runs/r1/events?after=2")).json()) as AgentRunEvent[])).toEqual([]);
    expect((await h.get("/v1/runs/r1/events?after=x")).status).toBe(400);
    expect((await h.get("/v1/runs/nope/events")).status).toBe(404);
  });

  test("SSE: replays in order, resumes after a seq (query or Last-Event-ID), streams live events, and ends when the run closes", async () => {
    const h = harness();
    const run = await h.recorder.start(start("live"));
    await run.event({ type: "message", text: "a" });
    await run.event({ type: "message", text: "b" });
    const sse = { Accept: "text/event-stream" };

    // Open the stream while the run is still running; write more after it started reading.
    const res = await h.get("/v1/runs/live/events", sse);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reading = frames(res);
    await Bun.sleep(50);
    await run.event({ type: "tool_call", tool: { callId: "c1", name: "shell_command", args: "{}" } });
    await Bun.sleep(300); // past the recorder's flush interval
    await run.event({ type: "tool_result", tool: { callId: "c1", name: "shell_command", result: "ok" } });
    await run.finish({ status: "done" });
    const got = await reading;
    const events = got.filter((f) => f.event === "run_event");
    expect(events.map((f) => Number(f.id))).toEqual([0, 1, 2, 3]);
    expect(events.map((f) => AgentRunEvent.parse(JSON.parse(f.data!)).type)).toEqual(["message", "message", "tool_call", "tool_result"]);
    expect(got.at(-1)).toMatchObject({ event: "end" });
    expect(JSON.parse(got.at(-1)!.data!)).toEqual({ status: "done" });

    // A closed run replays and ends; ?after and Last-Event-ID resume without repeats; ?after wins.
    const after1 = (await frames(await h.get("/v1/runs/live/events?after=1", sse))).filter((f) => f.event === "run_event").map((f) => Number(f.id));
    expect(after1).toEqual([2, 3]);
    const viaHeader = (await frames(await h.get("/v1/runs/live/events", { ...sse, "Last-Event-ID": "2" }))).filter((f) => f.event === "run_event");
    expect(viaHeader.map((f) => Number(f.id))).toEqual([3]);
    const both = (await frames(await h.get("/v1/runs/live/events?after=0", { ...sse, "Last-Event-ID": "3" }))).filter((f) => f.event === "run_event");
    expect(both.map((f) => Number(f.id))).toEqual([1, 2, 3]);
    const none = await frames(await h.get("/v1/runs/live/events?after=3", sse));
    expect(none.map((f) => f.event)).toEqual(["run_state", "end"]);
  });

  test("SSE: a client that disconnects stops the loop; a failed run ends the stream with its status", async () => {
    const h = harness();
    const run = await h.recorder.start(start("r"));
    const controller = new AbortController();
    const res = await h.app.request("/v1/runs/r/events", { headers: { ...H, Accept: "text/event-stream" }, signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read(); // retry hint
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await run.finish({ status: "failed", error: "x" });
    const again = await frames(await h.get("/v1/runs/r/events", { Accept: "text/event-stream" }));
    expect(JSON.parse(again.at(-1)!.data!)).toEqual({ status: "failed" });
  });

  test("plugin policy decisions become policy events only when the plugin reports them; nothing is synthesised", async () => {
    const h = harness();
    const run = await h.recorder.start(start("r"));
    expect(((await (await h.get("/v1/runs/r/events")).json()) as unknown[])).toEqual([]);
    const post = (id: string, body: unknown) => h.app.request(`/v1/runs/${id}/policy`, { method: "POST", headers: { ...H,
      "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = await post("r", { decision: "reject", rule: "no-push-outside-trail", reason: "git push to main is not allowed", tool: "shell_command",
      callId: "c9" });
    expect(ok.status).toBe(201);
    const events = await (await h.get("/v1/runs/r/events")).json() as AgentRunEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 0, type: "policy", policy: { decision: "reject", rule: "no-push-outside-trail" }, tool: { name: "shell_command",
      callId: "c9" } });
    expect((await post("r", { decision: "maybe", rule: "x", reason: "" })).status).toBe(400);
    expect((await post("nope", { decision: "allow", rule: "x", reason: "" })).status).toBe(404);
    await run.finish({ status: "done" });
    expect((await post("r", { decision: "allow", rule: "x", reason: "" })).status).toBe(409);
    expect((await h.app.request("/v1/runs/r/policy", { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("with sign-in required, a signed-in non-approver cannot post policy events but the service token (the plugin) can", async () => {
    const store = new MemoryRunStore();
    const broker = new RunBroker();
    const port = { usage: new MemoryUsageStore(), trails: async () => [], activity: async () => [], docs: {} as never, drafts: {} as never, runs: store,
      broker, now: () => new Date() };
    const app = createApp(TOKEN, {} as never, new Hono(), async (t) => (t === "human-token" ? { did: "did:example:viewer" } : null),
      { requireSignIn: true, approvers: new Set(["did:example:approver"]) }, (a) => consoleRoutes(port, a));
    await new RunRecorder(store, broker).start(start("r"));
    const body = JSON.stringify({ decision: "allow", rule: "r1", reason: "fine" });
    expect((await app.request("/v1/runs/r/policy", { method: "POST", body, headers: { Authorization: "Bearer human-token",
      "content-type": "application/json" } })).status).toBe(403);
    expect((await app.request("/v1/runs/r/policy", { method: "POST", body, headers: { ...H, "content-type": "application/json" } })).status).toBe(201);
  });
});
