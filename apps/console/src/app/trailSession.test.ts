import { expect, test } from "bun:test";
import { ApiError, UnknownWriteOutcome, type ConsoleApi } from "../api.ts";
import { getTrailSession, TrailSession } from "./trailSession.ts";

function fixture() {
  const writes: { action: string; input: unknown; key: string }[] = [];
  let fail: "unknown" | "forbidden" | null = null;
  let receipt: "recorded" | "not_found" = "not_found";
  const api = {
    trailAction: async (_id: string, action: string, input: unknown, key: string) => {
      writes.push({ action, input, key });
      if (fail === "unknown") throw new UnknownWriteOutcome(key);
      if (fail === "forbidden") throw new ApiError(403);
    },
    trailOperation: async () => ({ status: receipt }),
  } as unknown as ConsoleApi;
  return { api, writes, failure: (value: typeof fail) => { fail = value; }, receipt: (value: typeof receipt) => { receipt = value; } };
}

test("route revisits retain drafts, while account, API and quest changes isolate them", () => {
  const f = fixture();
  const session = getTrailSession(f.api, "alice", "one");
  session.setDraft("Please inspect the coupon path.");
  expect(getTrailSession(f.api, "alice", "one")).toBe(session);
  expect(getTrailSession(f.api, "bob", "one").getSnapshot().draft).toBe("");
  expect(getTrailSession(f.api, "alice", "two").getSnapshot().draft).toBe("");
  expect(getTrailSession(fixture().api, "alice", "one").getSnapshot().draft).toBe("");
});

test("unknown outcomes retain intent and key; only an explicit checked retry can resend", async () => {
  const f = fixture(); f.failure("unknown");
  const session = new TrailSession(f.api, "one");
  session.setDraft("Original comment");
  await expect(session.act("comment", { text: "Original comment" })).rejects.toBeInstanceOf(UnknownWriteOutcome);
  session.setDraft("A different next comment");
  await expect(session.act("comment", { text: "A different next comment" })).rejects.toThrow("pending");
  await expect(session.retry()).rejects.toThrow("Check delivery");
  expect(f.writes).toHaveLength(1);
  await session.reconcile();
  expect(session.getSnapshot().pending?.phase).toBe("not_found");
  expect(f.writes).toHaveLength(1);
  f.failure(null);
  await session.retry();
  expect(f.writes[1]).toEqual(f.writes[0]);
  expect(session.getSnapshot()).toEqual({ draft: "A different next comment" });
});

test("recorded receipt confirms a lost response without writing again", async () => {
  const f = fixture(); f.failure("unknown"); f.receipt("recorded");
  const session = new TrailSession(f.api, "one");
  session.setDraft("  Keep receipt rounding.  ");
  await expect(session.act("comment", { text: "Keep receipt rounding." })).rejects.toBeInstanceOf(UnknownWriteOutcome);
  await session.reconcile();
  expect(f.writes).toHaveLength(1);
  expect(session.getSnapshot()).toEqual({ draft: "" });
});

test("definite rejection retains draft and permits correction with a fresh intent", async () => {
  const f = fixture(); f.failure("forbidden");
  const session = new TrailSession(f.api, "one"); session.setDraft("A note");
  await expect(session.act("comment", { text: "A note" })).rejects.toBeInstanceOf(ApiError);
  expect(session.getSnapshot()).toEqual({ draft: "A note" });
  f.failure(null); await session.act("comment", { text: "A note" });
  expect(f.writes[0]?.key).not.toBe(f.writes[1]?.key);
});

test("a successful claim does not clear the independent comment draft", async () => {
  const f = fixture(); const session = new TrailSession(f.api, "one");
  session.setDraft("Work in progress"); await session.act("claim", {});
  expect(session.getSnapshot()).toEqual({ draft: "Work in progress" });
});

test("a late receipt for a completed operation cannot erase a new pending change", async () => {
  const f = fixture(); f.failure("unknown");
  const resolvers: ((value: { status: "recorded" }) => void)[] = [];
  f.api.trailOperation = () => new Promise((resolve) => resolvers.push(resolve));
  const session = new TrailSession(f.api, "one");
  await expect(session.act("claim", {})).rejects.toBeInstanceOf(UnknownWriteOutcome);
  const first = session.reconcile(); const late = session.reconcile();
  resolvers[0]!({ status: "recorded" }); await first;
  await expect(session.act("release", {})).rejects.toBeInstanceOf(UnknownWriteOutcome);
  const key = session.getSnapshot().pending?.key;
  resolvers[1]!({ status: "recorded" }); await late;
  expect(session.getSnapshot().pending?.key).toBe(key);
  expect(session.getSnapshot().pending?.action).toBe("release");
});
