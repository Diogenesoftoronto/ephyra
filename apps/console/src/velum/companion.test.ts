import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { VoiceReplyInput } from "@ephyra/core";
import { UnknownWriteOutcome, VoiceRequestError } from "../api.ts";
import { VelumCompanion } from "./companion.ts";

const TRAIL = "3a77e1aa-5b1e-4c3a-9d2f-000000000003";
const ctx = { kind: "overview" as const };
const reply = (text: string, op: string) => ({ text, contextLabel: "Overview", receipt: { operationKey: op, engine: "fixture/velum", requestedModel: "f", tokens: null, costMicrousd: null, billedTo: "local" as const } });

function api(script: (input: VoiceReplyInput, op: string, signal: AbortSignal) => Promise<ReturnType<typeof reply>>) {
  const calls: { input: VoiceReplyInput; op: string }[] = [];
  return { calls, voiceReply: async (input: VoiceReplyInput, op: string, signal: AbortSignal) => { calls.push({ input, op }); return script(input, op, signal); } };
}
let n = 0;
const keys = () => `velum-op-${n++}`;

describe("Velum companion", () => {
  test("selected references are sent with the turn and stay for the follow-up", async () => {
    const a = api(async (_i, op) => reply("ok", op));
    const c = new VelumCompanion("acct:w1", a, keys);
    c.add({ kind: "area", name: "payments", revision: "d1" }, "payments area", "area:payments");
    c.add({ kind: "trail", id: TRAIL, rev: 3 }, "T-3a77e1", "trail:x");
    expect(await c.send("Why is this risky?", ctx, "Overview")).toEqual({ kind: "sent" });
    expect(a.calls[0]!.input.references).toEqual([{ kind: "area", name: "payments", revision: "d1" }, { kind: "trail", id: TRAIL, rev: 3 }]);
    expect(c.getSnapshot().chips).toHaveLength(2);
    expect(c.getSnapshot().turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    c.clear();
    await c.send("And now?", ctx, "Overview");
    expect(a.calls[1]!.input.references).toBeUndefined();
    expect(a.calls[1]!.input.messages.map((m) => m.text)).toEqual(["Why is this risky?", "ok", "And now?"]);
  });
  test("an unknown outcome blocks new sends until checked with the same key; checking never changes the key", async () => {
    let lose = true;
    const a = api(async (_i, op) => { if (lose) throw new UnknownWriteOutcome(op); return reply("late answer", op); });
    const c = new VelumCompanion("s", a, keys);
    expect(await c.send("hello", ctx, "Overview")).toEqual({ kind: "unconfirmed" });
    const turn = c.getSnapshot().turns[0]!;
    expect(turn.role === "user" && turn.status).toBe("unconfirmed");
    expect(await c.send("another", ctx, "Overview")).toEqual({ kind: "kept", text: "another" });
    expect(a.calls).toHaveLength(1);
    lose = false;
    await c.checkSaved(turn.id);
    expect(a.calls.map((x) => x.op)).toEqual([a.calls[0]!.op, a.calls[0]!.op]);
    expect(JSON.stringify(a.calls[1]!.input)).toBe(JSON.stringify(a.calls[0]!.input));
    expect(c.getSnapshot().turns.at(-1)).toMatchObject({ role: "assistant", text: "late answer" });
  });
  test("rate limits keep the words, report only the server's wait, and allow a fresh send", async () => {
    let limited = true;
    const a = api(async (_i, op) => { if (limited) throw new VoiceRequestError("rate_limited", "busy", op, undefined, 12); return reply("ok", op); });
    const c = new VelumCompanion("s", a, keys);
    expect(await c.send("keep me", ctx, "Overview")).toEqual({ kind: "kept", text: "keep me" });
    expect(c.getSnapshot().draft).toBe("keep me");
    expect(c.getSnapshot().turns[0]).toMatchObject({ status: "rate-limited", retryAfterSeconds: 12 });
    limited = false;
    expect(await c.send("keep me", ctx, "Overview")).toEqual({ kind: "sent" });
    expect(a.calls[1]!.op).not.toBe(a.calls[0]!.op);
  });
  test("a changed reference is refused, the turn is withdrawn and the chip asks for refresh", async () => {
    const a = api(async (input, op) => { throw new VoiceRequestError("reference_changed", "changed", op, [{ key: `trail:${TRAIL}@3`, label: "q", status: "changed", current: "4" }]); });
    const c = new VelumCompanion("s", a, keys);
    c.add({ kind: "trail", id: TRAIL, rev: 3 }, "T-3a77e1", "trail:x");
    expect(await c.send("what now", ctx, "Overview")).toEqual({ kind: "kept", text: "what now" });
    expect(c.getSnapshot().turns).toHaveLength(0);
    expect(c.getSnapshot().chips[0]!.status).toBe("changed");
    expect(await c.send("what now", ctx, "Overview")).toEqual({ kind: "kept", text: "what now" });
    expect(a.calls).toHaveLength(1);
  });
  test("the page reports a newer revision; refresh replaces the chip in place", () => {
    const c = new VelumCompanion("s", api(async (_i, op) => reply("", op)), keys);
    c.add({ kind: "trail", id: TRAIL, rev: 3 }, "T-3a77e1 r3", "trail:x");
    c.reconcile(new Map([["trail:x", { ref: { kind: "trail" as const, id: TRAIL, rev: 4 }, label: "T-3a77e1 r4" }]]));
    expect(c.getSnapshot().chips[0]).toMatchObject({ status: "changed" });
    c.refresh(c.getSnapshot().chips[0]!.key);
    expect(c.getSnapshot().chips[0]).toMatchObject({ status: "current", label: "T-3a77e1 r4", key: `trail:${TRAIL}@4` });
  });
  test("results that arrive after dispose or stop never land", async () => {
    let resolve!: (v: ReturnType<typeof reply>) => void;
    const a = api(() => new Promise((r) => { resolve = r; }));
    const c = new VelumCompanion("s", a, keys);
    const sent = c.send("slow", ctx, "Overview");
    c.stop();
    resolve(reply("too late", "x"));
    expect(await sent).toEqual({ kind: "discarded" });
    expect(c.getSnapshot().turns).toHaveLength(1);
    expect(c.getSnapshot().turns[0]).toMatchObject({ status: "unconfirmed" });
    const d = new VelumCompanion("t", api(() => new Promise((r) => { resolve = r; })), keys);
    const late = d.send("x", ctx, "Overview");
    d.dispose();
    resolve(reply("late", "y"));
    expect(await late).toEqual({ kind: "discarded" });
    expect(d.getSnapshot().turns.filter((t) => t.role === "assistant")).toHaveLength(0);
  });
  test("chip operations never exceed the limit or duplicate a key", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom("add", "toggle", "remove", "clear"), fc.integer({ min: 0, max: 9 }), fc.integer({ min: 1, max: 3 }))), (ops) => {
      const c = new VelumCompanion("p", api(async (_i, op) => reply("", op)), keys);
      for (const [op, i, rev] of ops) {
        const ref = { kind: "area" as const, name: `a${i}`, revision: `r${rev}` };
        if (op === "add") c.add(ref, `a${i}`, `area:a${i}`);
        else if (op === "toggle") c.toggle(ref, `a${i}`, `area:a${i}`);
        else if (op === "remove") c.remove(`area:a${i}@r${rev}`);
        else c.clear();
        const keysNow = c.getSnapshot().chips.map((x) => x.key);
        expect(new Set(keysNow).size).toBe(keysNow.length);
        expect(keysNow.length).toBeLessThanOrEqual(6);
      }
    }));
  });
});
