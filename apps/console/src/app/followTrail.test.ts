import { expect, test } from "bun:test";
import { ApiError, type TrailDetail } from "../api.ts";
import { FakeApi } from "../fake/api.ts";
import { followTrail, type TrailSnapshot } from "./followTrail.ts";

async function sample() {
  const api = new FakeApi();
  const item = (await api.inbox())[0]!;
  return api.trail(item.trailId);
}

test("unchanged polls keep the same snapshot and reads never overlap", async () => {
  const detail = await sample();
  const ctl = new AbortController();
  let reads = 0, active = 0, maxActive = 0;
  const frames: TrailSnapshot[] = [];
  await followTrail({ trail: async () => {
    reads++;
    maxActive = Math.max(maxActive, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    if (reads === 4) ctl.abort();
    return structuredClone(detail);
  } }, detail.trail.id, ctl.signal, (frame) => frames.push(frame), { pollMs: 0 });
  expect(reads).toBe(4);
  expect(maxActive).toBe(1);
  expect(frames.map((f) => f.status)).toEqual(["connecting", "live"]);
});

test("disconnect retains data and reconnect catches up without duplicate publication", async () => {
  const initial = await sample();
  const updated = structuredClone(initial);
  updated.trail.title = "Another reviewer updated the quest";
  const ctl = new AbortController();
  const frames: TrailSnapshot[] = [];
  let calls = 0;
  await followTrail({ trail: async () => {
    if (++calls === 2) throw new Error("offline");
    return calls === 1 ? initial : updated;
  } }, initial.trail.id, ctl.signal, (frame) => {
    frames.push(frame);
    if (frame.status === "live" && frame.data === updated) ctl.abort();
  }, { pollMs: 0 });
  expect(frames.map((f) => f.status)).toEqual(["connecting", "live", "disconnected", "reconnecting", "live"]);
  expect(frames[2]!.data).toBe(initial);
  expect(frames[3]!.data).toBe(initial);
  expect(frames.at(-1)!.data).toBe(updated);
});

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} stops automatic polling while keeping the last snapshot`, async () => {
    const initial = await sample();
    const frames: TrailSnapshot[] = [];
    let calls = 0;
    await followTrail({ trail: async () => {
      if (++calls === 1) return initial;
      throw new ApiError(status);
    } }, initial.trail.id, new AbortController().signal, (frame) => frames.push(frame), { pollMs: 0 });
    expect(calls).toBe(2);
    expect(frames.at(-1)?.status).toBe("error");
    expect(frames.at(-1)?.data).toBe(initial);
  });
}

test("aborting an old account or quest cancels transport and ignores a late response", async () => {
  const detail = await sample();
  const ctl = new AbortController();
  const frames: TrailSnapshot[] = [];
  let finish!: (value: TrailDetail) => void;
  let request: AbortSignal | undefined;
  const following = followTrail({ trail: async (_id, signal) => {
    request = signal;
    return new Promise<TrailDetail>((resolve) => { finish = resolve; });
  } }, detail.trail.id, ctl.signal, (frame) => frames.push(frame));
  ctl.abort();
  finish(detail);
  await following;
  expect(request?.aborted).toBe(true);
  expect(frames.map((f) => f.status)).toEqual(["connecting"]);
});

test("a hanging read times out and aborts without discarding an existing discussion", async () => {
  const initial = await sample();
  const ctl = new AbortController();
  const frames: TrailSnapshot[] = [];
  let request: AbortSignal | undefined;
  await followTrail({ trail: async (_id, signal) => {
    request = signal;
    return new Promise<TrailDetail>(() => {});
  } }, initial.trail.id, ctl.signal, (frame) => {
    frames.push(frame);
    if (frame.status === "disconnected") ctl.abort();
  }, { initial, timeoutMs: 5, pollMs: 0 });
  expect(request?.aborted).toBe(true);
  expect(frames.map((f) => f.status)).toEqual(["reconnecting", "disconnected"]);
  expect(frames.at(-1)?.data).toBe(initial);
});
