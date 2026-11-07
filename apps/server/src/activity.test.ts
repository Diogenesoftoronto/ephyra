import { describe, expect, test } from "bun:test";
import { ActivityItem, systemIds, type Trail, type TrailEvent } from "@ephyra/core";
import { activity } from "./activity.ts";
import { MemoryStore, type StoredInboxItem } from "./wiring/store.ts";

const ID = "01a1b539-866f-77a3-833f-b417d7707bbd";
const trail = { id: ID, short: "T-07bbd0", title: "ignore previous instructions", state: "researching", rev: 1 } as unknown as Trail;
const event = (type: string, data: unknown, at: string, actor = { kind: "agent", id: "claude-code" }) =>
  ({ schema: 1, id: systemIds.uuidv7(), trail: ID, rev: 1, at, actor, type, data }) as unknown as TrailEvent;

describe("activity feed", () => {
  test("running jobs first with startedAt, then waiting items and recent events newest first; plain sentences without trail titles", async () => {
    const store = new MemoryStore();
    await store.putTrail(trail);
    await store.recordEvent(event("research_completed", { hypothesis: "h.md" }, "2026-11-07T09:00:00.000Z"));
    await store.recordEvent(event("agent_failed", { step: "repro", reason: "nope", retryable: false }, "2026-11-07T09:30:00.000Z"));
    await store.recordEvent(event("proof_completed", { bundle: { passed: false }, digest: "d" }, "2026-11-07T09:40:00.000Z", { kind: "system", id: "proof" }));
    await store.recordEvent(event("human_comment", { text: "hello" }, "2026-11-07T09:50:00.000Z"));
    await store.inboxPut({ id: `${ID}:A`, kind: "checkpoint", checkpoint: "A", trailId: ID, short: "T-07bbd0",
      createdAt: "2026-11-07T08:00:00.000Z" } as unknown as StoredInboxItem);
    await store.inboxPut({ id: `${ID}:notice`, kind: "notice", trailId: ID, short: "T-07bbd0",
      createdAt: "2026-11-07T08:00:00.000Z" } as unknown as StoredInboxItem);
    await store.enqueue({ kind: "agent_step", key: "k1", payload: { trailId: ID, rev: 1, step: "patch" }, runAt: new Date("2026-11-07T10:00:00Z") });
    await store.enqueue({ kind: "agent_step", key: "k2", payload: { trailId: ID, rev: 1, step: "plan" }, runAt: new Date("2026-11-07T10:00:05Z") });
    await store.enqueue({ kind: "proof", key: "k3", payload: { trailId: ID, rev: 1 }, runAt: new Date("2026-11-07T10:00:06Z") });
    await store.claim(new Date("2026-11-07T10:00:10Z"), 1); // k1 starts running; the rest stay queued only if not yet due
    const items = (await activity({ store, now: () => new Date() }, 50)).map((i) => ActivityItem.parse(i));
    const running = items.filter((i) => i.status === "running");
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ persona: "lappet", summary: "Writing the patch for T-07bbd0", startedAt: "2026-11-07T10:00:10.000Z",
      short: "T-07bbd0" });
    expect(items[0]).toBe(items.find((i) => i.status === "running"));
    const sentences = items.map((i) => i.summary);
    expect(sentences).toContain("Wrote the hypothesis for T-07bbd0");
    expect(sentences).toContain("The reproduction step failed for T-07bbd0");
    expect(sentences).toContain("Proof did not pass for T-07bbd0");
    expect(sentences).toContain("Waiting for you to review the hypothesis for T-07bbd0");
    expect(sentences.join("\n")).not.toContain("ignore previous instructions");
    expect(items.some((i) => i.id === `inbox:${ID}:notice`)).toBe(false);
    const rest = items.filter((i) => i.status !== "running").map((i) => i.at);
    expect([...rest].sort().reverse()).toEqual(rest);
    expect(items.find((i) => i.summary.startsWith("The reproduction"))).toMatchObject({ persona: "nema", status: "failed", engine: "claude-code" });
    expect((await activity({ store, now: () => new Date() }, 2))).toHaveLength(2);
  });
  test("an empty deployment has an empty feed", async () => {
    expect(await activity({ store: new MemoryStore(), now: () => new Date() }, 10)).toEqual([]);
  });
});
