import { describe, expect, test } from "bun:test";
import { ActivityItem, Draft, PolicyDoc, Trail, TrailEvent, UsageEntry, UsageSummary } from "@ephyra/core";
import { z } from "zod";
import { ApiError, InboxItemSchema } from "../api.ts";
import { formMessage } from "../genui/form-message.ts";
import { readSpec } from "../genui/spec.ts";
import { FakeApi } from "./api.ts";
import { STORY_NOW, makeTrails } from "./fixtures.ts";

const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("FakeApi fixtures", () => {
  test("every payload passes the core schemas", async () => {
    const api = new FakeApi();
    z.array(ActivityItem).parse(await api.activity());
    UsageSummary.parse(await api.usage());
    z.array(UsageEntry).parse((await api.entries({ limit: 500 })).entries);
    z.array(PolicyDoc).parse(await api.docs());
    z.array(Draft).parse(await api.drafts());
    z.array(InboxItemSchema).parse(await api.inbox());
    for (const item of await api.inbox()) {
      const detail = await api.trail(item.trailId);
      Trail.parse(detail.trail);
      z.array(TrailEvent).parse(detail.events);
    }
  });

  test("trails exist at every checkpoint and are deterministic", async () => {
    const api = new FakeApi();
    const inbox = await api.inbox();
    expect(inbox.filter((i) => i.kind === "checkpoint").map((i) => i.checkpoint).sort()).toEqual(["A", "B", "C"]);
    expect(inbox.some((i) => i.kind === "spend")).toBe(true);
    expect(inbox.some((i) => i.kind === "parked")).toBe(true);
    expect(JSON.stringify(makeTrails(STORY_NOW))).toBe(JSON.stringify(makeTrails(STORY_NOW)));
    expect(JSON.stringify(await new FakeApi().usage())).toBe(JSON.stringify(await api.usage()));
  });

  test("activity has running items with start times", async () => {
    const running = (await new FakeApi().activity()).filter((a) => a.status === "running");
    expect(running.length).toBeGreaterThanOrEqual(3);
    expect(running.every((a) => a.startedAt)).toBe(true);
  });

  test("usage covers 14 days with unknown, failed and unavailable rows, and never counts unknown as zero", async () => {
    const api = new FakeApi();
    const from = new Date(STORY_NOW - 13 * 86_400_000).toISOString();
    const s = await api.usage({ from });
    expect(s.byDay).toHaveLength(14);
    expect(s.totals.unknownCost).toBeGreaterThan(0);
    expect(s.totals.failed).toBeGreaterThan(0);
    expect(s.totals.unavailable).toBeGreaterThan(0);
    const { entries } = await api.entries({ from, limit: 1000 });
    expect(entries.filter((e) => e.costMicrousd === null)).toHaveLength(s.totals.unknownCost);
    expect(entries.every((e) => Date.parse(e.at) <= STORY_NOW)).toBe(true);
    expect(s.byPersona.reduce((n, g) => n + g.totals.entries, 0)).toBe(s.totals.entries);
  });

  test("entries paginate and filter", async () => {
    const api = new FakeApi();
    const first = await api.entries({ limit: 5 });
    expect(first.entries).toHaveLength(5);
    expect(first.cursor).toBe("5");
    const second = await api.entries({ limit: 5, cursor: first.cursor });
    expect(second.entries[0]!.id).not.toBe(first.entries[0]!.id);
    const nema = await api.entries({ persona: "nema", limit: 500 });
    expect(nema.entries.every((e) => e.persona === "nema")).toBe(true);
  });
});

describe("FakeApi writes", () => {
  test("approving removes the inbox item and a repeated operation key changes nothing twice", async () => {
    const api = new FakeApi();
    const a = (await api.inbox()).find((i) => i.checkpoint === "A")!;
    await api.decide(a.trailId, { checkpoint: "A", verdict: "approve", note: "ok" }, "op-1");
    await api.decide(a.trailId, { checkpoint: "A", verdict: "approve", note: "ok" }, "op-1");
    expect(api.writes.filter(([k]) => k === "decide")).toHaveLength(1);
    expect((await api.inbox()).some((i) => i.trailId === a.trailId && i.checkpoint === "A")).toBe(false);
    expect((await api.trail(a.trailId)).trail.checkpoints.A?.note).toBe("ok");
  });

  test("a stale approval answers 409 and records nothing", async () => {
    const probe = await new FakeApi().inbox();
    const c = probe.find((i) => i.checkpoint === "C")!;
    const api = new FakeApi({ staleTrails: [c.trailId] });
    const error = await rejects(api.decide(c.trailId, { checkpoint: "C", verdict: "approve" }, "op-2"));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect(api.writes).toHaveLength(0);
  });

  test("non-approvers get 403 on every write", async () => {
    const api = new FakeApi({ approver: false });
    const d = (await api.drafts("open"))[0]!;
    expect(((await rejects(api.publish(d.id, "p"))) as ApiError).status).toBe(403);
    expect(((await rejects(api.decide((await api.inbox())[0]!.trailId, { checkpoint: "A", verdict: "approve" }, "q"))) as ApiError).status).toBe(403);
  });

  test("comment, claim and park change the trail and the timeline", async () => {
    const api = new FakeApi();
    const id = (await api.inbox())[0]!.trailId;
    await api.trailAction(id, "comment", { text: "Looks right to me." }, "c1");
    await api.trailAction(id, "claim", {}, "c2");
    await api.trailAction(id, "park", { reason: "later" }, "c3");
    const { trail, events } = await api.trail(id);
    expect(trail.state).toBe("parked");
    expect(trail.owner?.id).toContain("alex");
    expect(events.slice(-3).map((e) => e.type)).toEqual(["human_comment", "claimed_by_human", "parked"]);
  });
});

describe("FakeApi drafts and Velum", () => {
  test("a billing message gets a proposal, a catalog-valid spec and warnings from the parser stand-in", async () => {
    const api = new FakeApi({ seedConversation: false });
    const draft = await api.createDraft("autonomy.md", "d1");
    const after = await api.sendMessage(draft.id, "Add an area for billing please", "m1");
    const reply = after.messages.at(-1)!;
    expect(reply.role).toBe("persona");
    expect(reply.proposal?.content).toContain("## area: billing");
    expect(readSpec(reply.spec).ok).toBe(true);
    const applied = await api.applyProposal(draft.id, reply.id, "a1");
    expect(applied.content).toContain("## area: billing");
  });

  test("applying a form goes through Velum and rewrites only that area", async () => {
    const api = new FakeApi({ seedConversation: false });
    const draft = await api.createDraft("autonomy.md", "d1");
    const values = { area: { name: "billing", paths: ["src/billing/**", " "], risk: "critical", userFacing: true,
      checkpoints: { A: "blocking", B: "blocking", C: "blocking" }, landing: ["trail_ref"], watchSeconds: 3600, voxqMicrousd: 0 } };
    const reply = (await api.sendMessage(draft.id, formMessage(values), "m1")).messages.at(-1)!;
    expect(reply.proposal?.content).toContain("risk: critical");
    expect(reply.proposal?.content).toContain("watch: 1h");
    expect(reply.proposal?.content).toContain("## area: payments");
    expect(reply.proposal?.content).not.toContain("paths: src/billing/**, ");
  });

  test("a proposal with parser errors cannot be applied, and a draft with errors cannot be published", async () => {
    const api = new FakeApi({ seedConversation: false });
    const draft = await api.createDraft("autonomy.md", "d1");
    const reply = (await api.sendMessage(draft.id, "this is broken", "m1")).messages.at(-1)!;
    expect(reply.proposal?.warnings.join()).toContain("invalid risk");
    expect(((await rejects(api.applyProposal(draft.id, reply.id, "a1"))) as ApiError).status).toBe(409);
    await api.updateContent(draft.id, `${draft.content}\n## area: x\nrisk: severe\n`, draft.baseDigest, "u1");
    expect(((await rejects(api.publish(draft.id, "p1"))) as ApiError).status).toBe(409);
  });

  test("an unavailable model is an Unverified error, never a made-up reply", async () => {
    const api = new FakeApi({ velumUnavailable: true });
    const error = (await rejects(api.sendMessage("d-1", "hello", "m1"))) as ApiError;
    expect(error.status).toBe(503);
    expect(error.detail).toContain("Unverified");
    expect((await api.draft("d-1")).messages.at(-1)!.text).not.toBe("hello");
  });

  test("publish records the ref; a moved document or a conflict answers 409", async () => {
    const api = new FakeApi({ seedConversation: false });
    const draft = await api.createDraft("autonomy.md", "d1");
    const published = await api.publish(draft.id, "p1");
    expect(published.status).toBe("published");
    expect(published.published?.ref).toBe(`refs/ephyra/policy/${draft.id}`);
    const conflict = new FakeApi({ publishConflict: true });
    expect(((await rejects(conflict.publish("d-1", "p2"))) as ApiError).status).toBe(409);
    const stale = await new FakeApi().updateContent("d-1", "x", "wrong-digest", "u").then(() => null, (e: unknown) => e);
    expect((stale as ApiError).status).toBe(409);
  });

  test("empty mode returns nothing", async () => {
    const api = new FakeApi({ empty: true });
    expect(await api.inbox()).toEqual([]);
    expect(await api.activity()).toEqual([]);
    expect((await api.usage()).totals.entries).toBe(0);
    expect(await api.docs()).toEqual([]);
  });
});
