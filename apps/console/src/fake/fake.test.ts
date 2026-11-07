import { describe, expect, test } from "bun:test";
import { ActivityItem, Draft, PolicyDoc, Trail, TrailEvent, UsageEntry, UsageSummary } from "@ephyra/core";
import { z } from "zod";
import { ApiError, InboxItemSchema } from "../api.ts";
import { formMessage } from "../lib/protocol.ts";
import { readSpec } from "../genui/spec.ts";
import { FakeApi } from "./api.ts";
import { STORY_NOW, makeTrails } from "./fixtures.ts";

const rejects = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

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
    expect(
      inbox
        .filter((i) => i.kind === "checkpoint")
        .map((i) => i.checkpoint)
        .sort(),
    ).toEqual(["A", "B", "C"]);
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
    expect(
      (
        (await rejects(
          api.decide((await api.inbox())[0]!.trailId, { checkpoint: "A", verdict: "approve" }, "q"),
        )) as ApiError
      ).status,
    ).toBe(403);
  });

  test("comment, claim, release and park preserve the revision and record their actors", async () => {
    const api = new FakeApi();
    const id = (await api.inbox())[0]!.trailId;
    const before = (await api.trail(id)).trail;
    await api.trailAction(id, "comment", { text: "Looks right to me." }, "c1");
    await api.trailAction(id, "claim", {}, "c2");
    const held = (await api.trail(id)).trail;
    expect(held.owner?.id).toContain("alex");
    expect(held.state).toBe("handed_off");
    expect(held.resumeTo).toBe(before.state);
    await api.trailAction(id, "release", {}, "c4");
    await api.trailAction(id, "park", { reason: "later" }, "c3");
    const { trail, events } = await api.trail(id);
    expect(trail.state).toBe("parked");
    expect(trail.rev).toBe(before.rev);
    expect(trail.owner).toBeUndefined();
    expect(events.slice(-4).map((e) => e.type)).toEqual(["human_comment", "claimed_by_human", "released_by_human", "parked"]);
  });

  test("only the claimant can release a review and receipts are scoped to the exact principal", async () => {
    const options = { principal: "did:example:alice" };
    const api = new FakeApi(options);
    const item = (await api.inbox()).find((i) => i.checkpoint === "A")!;
    await api.trailAction(item.trailId, "claim", {}, "claim");
    expect(await api.trailOperation(item.trailId, "claim", "claim")).toEqual({ status: "recorded" });
    options.principal = "did:example:bob";
    expect(await api.trailOperation(item.trailId, "claim", "claim")).toEqual({ status: "not_found" });
    for (const action of ["claim", "release", "park", "resume"] as const) {
      expect(((await rejects(api.trailAction(item.trailId, action, {}, action))) as ApiError).status).toBe(409);
    }
    expect(((await rejects(api.decide(item.trailId, { checkpoint: "A", verdict: "approve" }, "decide"))) as ApiError).status).toBe(409);
    await api.trailAction(item.trailId, "comment", { text: "I can still add evidence." }, "comment");
    expect((await api.trail(item.trailId)).events.at(-1)?.actor.id).toBe(options.principal);
    options.principal = "did:example:alice";
    await api.trailAction(item.trailId, "release", {}, "release");
    expect((await api.trail(item.trailId)).trail).toMatchObject({ state: "hypothesised" });
  });

  test("shared action keys deduplicate, reject changed intent, and remain separate by trail and action", async () => {
    const api = new FakeApi();
    const [a, b] = (await api.inbox()).filter((i) => i.kind === "checkpoint");
    const before = (await api.trail(a!.trailId)).events.length;
    await api.trailAction(a!.trailId, "comment", { text: "same note" }, "same-key");
    await api.trailAction(a!.trailId, "comment", { text: "same note" }, "same-key");
    expect((await api.trail(a!.trailId)).events.length).toBe(before + 1);
    expect(((await rejects(api.trailAction(a!.trailId, "comment", { text: "changed" }, "same-key"))) as ApiError).status).toBe(409);
    await api.trailAction(a!.trailId, "claim", {}, "same-key");
    await api.trailAction(b!.trailId, "comment", { text: "different trail" }, "same-key");
    expect(await api.trailOperation(b!.trailId, "claim", "same-key")).toEqual({ status: "not_found" });
  });

  test("review claims refuse active work and comments reject empty or excessive text", async () => {
    const api = new FakeApi();
    const active = api.snapshot().trails.find((t) => t.state === "watching")!;
    expect(((await rejects(api.trailAction(active.id, "claim", {}, "claim"))) as ApiError).status).toBe(409);
    for (const text of ["", "  ", "x".repeat(4001)]) {
      expect(((await rejects(api.trailAction(active.id, "comment", { text }, text))) as ApiError).status).toBe(400);
    }
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
    const values = {
      area: {
        name: "billing",
        paths: ["src/billing/**", " "],
        risk: "critical",
        userFacing: true,
        checkpoints: { A: "blocking", B: "blocking", C: "blocking" },
        landing: ["trail_ref"],
        watchSeconds: 3600,
        voxqMicrousd: 0,
      },
    };
    const reply = (await api.sendMessage(draft.id, formMessage(values), "m1")).messages.at(-1)!;
    expect(reply.proposal?.content).toContain("risk: critical");
    expect(reply.proposal?.content).toContain("watch: 1h");
    expect(reply.proposal?.content).toContain("## area: payments");
    expect(reply.proposal?.content).not.toContain("paths: src/billing/**, ");
  });

  test("edited catalog values go through the same message shape as the draft screen", async () => {
    const api = new FakeApi();
    const draft = await api.draft("d-1");
    const spec = readSpec(draft.messages.at(-1)!.spec);
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    const values = Object.fromEntries(spec.fields.map((f) => [f.path, f.value]));
    values["area.billing.name"] = "billing-review";
    values["area.billing.watch"] = "3h";
    const reply = (await api.sendMessage(draft.id, formMessage({ values }), "edited-form")).messages.at(-1)!;
    expect(reply.proposal?.content).toContain("## area: billing-review");
    expect(reply.proposal?.content).toContain("watch: 3h");
    const saved = await api.applyProposal(draft.id, reply.id, "edited-form-apply");
    expect(saved.sketches?.some((s) => s.name === "billing-review")).toBe(true);
  });

  test("a proposal with parser errors cannot be applied, and a draft with errors cannot be published", async () => {
    const api = new FakeApi({ seedConversation: false });
    const draft = await api.createDraft("autonomy.md", "d1");
    const reply = (await api.sendMessage(draft.id, "this is broken", "m1")).messages.at(-1)!;
    expect(reply.proposal?.warnings.join()).toContain("error: line");
    expect(((await rejects(api.applyProposal(draft.id, reply.id, "a1"))) as ApiError).status).toBe(409);
    await api.updateContent(draft.id, `${draft.content}\n## area: x\nrisk: severe\n`, draft.baseDigest, "u1");
    expect(((await rejects(api.publish(draft.id, "p1"))) as ApiError).status).toBe(409);
  });

  test("an unavailable model is a system message in the draft, never a made-up reply", async () => {
    const api = new FakeApi({ velumUnavailable: true, seedConversation: false });
    const draft = await api.createDraft("autonomy.md", "d");
    const after = await api.sendMessage(draft.id, "hello", "m1");
    const last = after.messages.at(-1)!;
    expect(last.role).toBe("system");
    expect(last.text).toContain("Unverified");
    expect(after.messages.some((m) => m.role === "persona")).toBe(false);
    expect(last.proposal).toBeUndefined();
  });

  test("publish records the ref; a moved document or a conflict answers 409", async () => {
    const api = new FakeApi({ seedConversation: false });
    const draft = await api.createDraft("autonomy.md", "d1");
    const published = await api.publish(draft.id, "p1");
    expect(published.status).toBe("published");
    expect(published.published?.ref).toBe(`refs/ephyra/policy/${draft.id}`);
    const conflict = new FakeApi({ publishConflict: true });
    expect(((await rejects(conflict.publish("d-1", "p2"))) as ApiError).status).toBe(409);
    const stale = await new FakeApi().updateContent("d-1", "x", "wrong-digest", "u").then(
      () => null,
      (e: unknown) => e,
    );
    expect((stale as ApiError).status).toBe(409);
  });

  test("the autonomy document and its drafts carry the application map; other documents do not", async () => {
    const api = new FakeApi();
    const docs = await api.docs();
    expect(docs.find((d) => d.path === "autonomy.md")?.sketches?.map((s) => s.name)).toEqual([
      "payments",
      "cart",
      "marketing-site",
    ]);
    expect(docs.find((d) => d.path === "thresholds.yaml")?.sketches).toBeUndefined();
    const seeded = await api.draft("d-1");
    expect(seeded.sketches?.map((s) => s.name)).toEqual(["payments", "cart", "marketing-site"]);
    expect(seeded.messages.at(-1)?.proposal?.sketches?.some((s) => s.name === "billing")).toBe(true);
  });

  test("saving the map renders it into the document, and refuses a stale base or a draft with errors", async () => {
    const api = new FakeApi({ seedConversation: false });
    const d = await api.createDraft("autonomy.md", "d");
    const edited = d.sketches!.map((s) => (s.name === "cart" ? { ...s, level: "research" as const } : s));
    const saved = await api.updateSketches(d.id, edited, d.baseDigest, "s1");
    expect(saved.sketches?.find((s) => s.name === "cart")?.level).toBe("research");
    expect(saved.content).toContain("<!-- level: research -->");
    expect(((await rejects(api.updateSketches(d.id, edited, "stale", "s2"))) as ApiError).status).toBe(409);
    await api.updateContent(d.id, `${saved.content}\n## area: x\nrisk: severe\n`, d.baseDigest, "u");
    const blocked = (await rejects(api.updateSketches(d.id, edited, d.baseDigest, "s3"))) as ApiError;
    expect([blocked.status, blocked.detail]).toEqual([
      409,
      "the draft text has errors; fix it before editing the map",
    ]);
    const intent = await api.createDraft("intents/search.md", "i");
    expect(
      ((await rejects(api.updateSketches(intent.id, [], intent.baseDigest, "s4"))) as ApiError).status,
    ).toBe(400);
  });

  test("a persona filter of `unattributed` finds work with no persona", async () => {
    const api = new FakeApi();
    const { entries } = await api.entries({ persona: "unattributed", limit: 200 });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.persona === null && e.step === "study")).toBe(true);
  });

  test("empty mode returns nothing", async () => {
    const api = new FakeApi({ empty: true });
    expect(await api.inbox()).toEqual([]);
    expect(await api.activity()).toEqual([]);
    expect((await api.usage()).totals.entries).toBe(0);
    expect(await api.docs()).toEqual([]);
  });
});
