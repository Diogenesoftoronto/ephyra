import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { AgentRun, AgentRunEvent, AreaSketch, AUTONOMY_LEVELS, type AgentRunEvent as Ev } from "@ephyra/core";
import { z } from "zod";
import { ConsoleClient, parseSseFrame } from "../api.ts";
import { FakeApi } from "./api.ts";
import { AUTONOMY_MD } from "./fixtures.ts";
import { RUN_IDS } from "./runs.ts";
import { renderSketch, replaceAreas, sketchesOf } from "./sketch.ts";
import { lintAutonomy } from "./autonomy.ts";

describe("run fixtures", () => {
  test("runs and events pass the core schemas, running first", async () => {
    const api = new FakeApi();
    const runs = z.array(AgentRun).parse(await api.runs());
    expect(runs[0]!.status).toBe("running");
    expect(new Set(runs.map((r) => r.status))).toEqual(new Set(["running", "done", "failed", "unavailable"]));
    for (const r of runs) {
      const events = z.array(AgentRunEvent).parse(await api.runEvents(r.id));
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    }
  });
  test("the orb run has a portal, a thread link, and a protected-ref rejection", async () => {
    const api = new FakeApi();
    const run = await api.run(RUN_IDS.orb);
    expect(run.executor).toMatchObject({ kind: "orb", id: "orb_7Qm2x" });
    expect(run.executor.portalUrl).toBeTruthy();
    expect(run.executor.threadUrl).toBeTruthy();
    const events = await api.runEvents(RUN_IDS.orb);
    const reject = events.find((e) => e.policy?.decision === "reject");
    expect(reject?.policy?.reason).toContain("protected ref");
    expect(events.some((e) => e.type === "reasoning")).toBe(true);
    expect(events.find((e) => e.tool?.isError)).toBeTruthy();
  });
  test("filters by trail and status", async () => {
    const api = new FakeApi();
    const failed = (await api.runs({ status: "failed" }))[0]!;
    expect(failed.error).toContain("did not compile");
    const forTrail = await api.runs({ trail: failed.trailId! });
    expect(forTrail.every((r) => r.trailId === failed.trailId)).toBe(true);
  });
  test("resumes after a sequence number", async () => {
    const api = new FakeApi();
    const all = await api.runEvents(RUN_IDS.orb);
    expect((await api.runEvents(RUN_IDS.orb, all[4]!.seq))[0]!.seq).toBe(all[5]!.seq);
  });
  test("a live run streams its tail, in order, and stops on abort", async () => {
    const api = new FakeApi({ streamIntervalMs: 0 });
    const first = await api.runEvents(RUN_IDS.orb);
    const got: Ev[] = [];
    const ctl = new AbortController();
    const done = api.watchRun(
      RUN_IDS.orb,
      first.at(-1)!.seq,
      (batch) => {
        got.push(...batch);
        if (got.length >= 4) ctl.abort();
      },
      ctl.signal,
    );
    await done;
    expect(got.map((e) => e.seq)).toEqual(got.map((_, i) => first.length + i));
    expect(got.at(-1)!.text).toContain("proof runner");
  });
  test("a finished run replays and ends", async () => {
    const api = new FakeApi();
    const got: Ev[] = [];
    const status = await api.watchRun(
      RUN_IDS.local,
      undefined,
      (b) => got.push(...b),
      new AbortController().signal,
    );
    expect(status).toBe("done");
    expect(got.length).toBe((await api.runEvents(RUN_IDS.local)).length);
  });
});

describe("SSE", () => {
  test("a frame becomes a validated event; junk is skipped", () => {
    const ev = { runId: "r", seq: 3, at: "2026-11-07T15:00:00.000Z", type: "status", text: "hi" };
    expect(parseSseFrame(`id: 3\nevent: run_event\ndata: ${JSON.stringify(ev)}`)).toEqual([
      { kind: "event", event: ev as Ev },
    ]);
    expect(parseSseFrame(": ping")).toEqual([]);
    expect(parseSseFrame("retry: 2000")).toEqual([]);
    expect(parseSseFrame("data: {not json")).toEqual([]);
    expect(parseSseFrame(`data: ${JSON.stringify({ ...ev, type: "shell" })}`)).toEqual([]);
    expect(parseSseFrame('event: end\ndata: {"status":"done"}')).toEqual([{ kind: "end", status: "done" }]);
    expect(parseSseFrame('event: end\ndata: {"status":"exploded"}')).toEqual([]);
  });
  test("the client reads a stream split across chunks and sends Accept: text/event-stream", async () => {
    const mk = (seq: number) => ({
      runId: "r",
      seq,
      at: "2026-11-07T15:00:00.000Z",
      type: "status",
      text: `s${seq}`,
    });
    const frame = (e: object) =>
      `id: ${(e as { seq: number }).seq}\nevent: run_event\ndata: ${JSON.stringify(e)}\n\n`;
    const payload = `retry: 2000\n\n${frame(mk(1))}: ping\n\n${frame(mk(2))}event: end\ndata: {"status":"done"}\n\n`;
    let accept = "";
    let url = "";
    const fetcher: typeof fetch = async (u, init) => {
      url = String(u);
      accept = (init?.headers as Record<string, string>).Accept!;
      const bytes = new TextEncoder().encode(payload);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes.slice(0, 20));
          c.enqueue(bytes.slice(20));
          c.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };
    const got: Ev[] = [];
    const status = await new ConsoleClient("https://x.test", "t", fetcher).watchRun(
      "r 1",
      0,
      (b) => got.push(...b),
      new AbortController().signal,
    );
    expect(got.map((e) => e.seq)).toEqual([1, 2]);
    expect(status).toBe("done");
    expect(accept).toBe("text/event-stream");
    expect(url).toBe("https://x.test/v1/runs/r%201/events?after=0");
  });
});

const sketch = fc.record({
  name: fc.stringMatching(/^[a-z][a-z0-9]{0,11}(-[a-z0-9]{1,6})?$/),
  intent: fc.stringMatching(/^[A-Za-z][A-Za-z ,.]{0,60}[A-Za-z.]$/),
  paths: fc.array(fc.stringMatching(/^[a-z]{1,8}\/\*\*$/), { minLength: 1, maxLength: 3 }),
  risk: fc.constantFrom("low", "medium", "high", "critical"),
  level: fc.constantFrom(...AUTONOMY_LEVELS.map((l) => l.id)),
  userFacing: fc.boolean(),
});

describe("application map (stand-in mapping)", () => {
  test("sketches survive a render and read back, and the document still lints clean", () => {
    fc.assert(
      fc.property(fc.uniqueArray(sketch, { selector: (s) => s.name, maxLength: 4 }), (sketches) => {
        const md = replaceAreas(AUTONOMY_MD, sketches);
        expect(sketchesOf(md)).toEqual(sketches);
        expect(lintAutonomy(md)).toEqual([]);
        sketches.forEach((s) => AreaSketch.parse(s));
      }),
    );
  });
  test("the fixture document reads as the three-level map", () => {
    expect(sketchesOf(AUTONOMY_MD).map((a) => [a.name, a.level, a.risk])).toEqual([
      ["payments", "propose", "critical"],
      ["cart", "patch", "medium"],
      ["marketing-site", "auto", "low"],
    ]);
    expect(renderSketch(sketchesOf(AUTONOMY_MD)[0]!)).toContain("Money moves here");
  });
  test("Velum answers a plain-language request with a before/after map", async () => {
    const api = new FakeApi({ seedConversation: false });
    const draft = await api.createDraft("autonomy.md", "d");
    const reply = (
      await api.sendMessage(
        draft.id,
        "payments should never land without me; the marketing site can fix itself",
        "m1",
      )
    ).messages.at(-1)!;
    expect(reply.proposal?.sketches?.map((s) => [s.name, s.level])).toContainEqual([
      "marketing-site",
      "auto",
    ]);
    z.array(AreaSketch).parse(reply.proposal!.sketches);
    const applied = await api.applyProposal(draft.id, reply.id, "a");
    expect(sketchesOf(applied.content).find((s) => s.name === "marketing-site")?.level).toBe("auto");
  });
});
