import { expect, test } from "bun:test";
import { FakeApi } from "../fake/api.ts";
import { RUN_IDS } from "../fake/runs.ts";
import { followRun, type RunSnapshot } from "./followRun.ts";

test("a live metadata snapshot updates access links without ending or reconnecting the stream", async () => {
  const api = new FakeApi();
  const initial = await api.run(RUN_IDS.orb);
  const ctl = new AbortController();
  const frames: RunSnapshot[] = [];
  api.run = async () => ({ ...initial, executor: { kind: "orb" } });
  api.watchRun = async (_id, _after, _batch, _signal, onRun) => {
    onRun?.({ ...initial, executor: { kind: "orb", threadUrl: "https://ampcode.com/threads/recorded-session" } });
    ctl.abort();
    onRun?.({ ...initial, id: "wrong-run", status: "done" });
    return null;
  };
  await followRun(api, initial.id, ctl.signal, (snapshot) => frames.push(snapshot));
  expect(frames).toHaveLength(2);
  expect(frames.at(-1)?.run.executor.threadUrl).toBe("https://ampcode.com/threads/recorded-session");
  expect(frames.at(-1)?.stream).toBe("live");
});

test("a clean disconnect resumes from the last sequence and de-duplicates replay", async () => {
  const api = new FakeApi();
  const initial = await api.run(RUN_IDS.orb);
  const first = await api.runEvents(initial.id);
  const last = first.at(-1)!;
  const afters: (number | undefined)[] = [];
  let finished = false;
  api.run = async () => (finished ? { ...initial, status: "done" } : initial);
  api.watchRun = async (_id, after, batch) => {
    afters.push(after);
    batch([last, { ...last, seq: last.seq + afters.length, type: "message", text: "next" }]);
    finished = afters.length === 2;
    return finished ? "done" : null;
  };
  const frames: RunSnapshot[] = [];
  await followRun(api, initial.id, new AbortController().signal, (s) => frames.push(s), 0);
  expect(afters).toEqual([last.seq, last.seq + 1]);
  expect(frames.some((s) => s.stream === "reconnecting")).toBe(true);
  expect(frames.at(-1)?.run.status).toBe("done");
  expect(frames.at(-1)?.events).toHaveLength(first.length + 2);
  expect(frames.filter((s) => s.stream === "ended")).toHaveLength(1);
});

test("lost streams retain the transcript and never mark an active run as ended", async () => {
  const api = new FakeApi();
  api.watchRun = async () => {
    throw new Error("offline");
  };
  const frames: RunSnapshot[] = [];
  await followRun(api, RUN_IDS.orb, new AbortController().signal, (s) => frames.push(s), 0);
  expect(frames.at(-1)?.stream).toBe("reconnecting");
  expect(frames.at(-1)?.events.length).toBeGreaterThan(0);
  expect(frames.some((s) => s.stream === "ended")).toBe(false);
});

test("aborted loads and late callbacks cannot publish into another run", async () => {
  const api = new FakeApi();
  const ctl = new AbortController();
  const frames: RunSnapshot[] = [];
  api.watchRun = async (_id, _after, batch) => {
    ctl.abort();
    batch(await api.runEvents(RUN_IDS.orb));
    return null;
  };
  await followRun(api, RUN_IDS.orb, ctl.signal, (s) => frames.push(s), 0);
  expect(frames).toHaveLength(1);
});
