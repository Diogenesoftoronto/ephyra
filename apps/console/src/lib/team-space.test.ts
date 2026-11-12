import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { TrailState } from "@ephyra/core";
import {
  asks, blockers, channelStatus, delivery, load, recentCounts, waitingKey, workGroups,
  type SpaceInbox, type SpaceQuestion, type SpaceTrail,
} from "./team-space.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const DIDS = ["did:plc:a", "did:plc:b", "did:plc:c"] as const;
const iso = fc.integer({ min: NOW - 60 * 86_400_000, max: NOW }).map((t) => new Date(t).toISOString());
const trailIds = ["t1", "t2", "t3", "t4"] as const;

const trail: fc.Arbitrary<SpaceTrail> = fc.record({
  id: fc.constantFrom(...trailIds), short: fc.constant("T-1"), title: fc.constant("Quest"),
  state: fc.constantFrom(...TrailState.options), area: fc.constant("checkout"), updatedAt: iso,
  owner: fc.option(fc.record({ kind: fc.constantFrom("agent" as const, "human" as const), id: fc.constantFrom(...DIDS) }), { nil: undefined }),
  landing: fc.option(fc.record({ receipts: fc.array(fc.constant({}), { maxLength: 2 }) }), { nil: undefined }),
});
const trails = fc.uniqueArray(trail, { selector: (t) => t.id, maxLength: 4 });

const question: fc.Arbitrary<SpaceQuestion> = fc.record({
  id: fc.stringMatching(/^[a-f0-9]{64}$/), trailId: fc.constantFrom(...trailIds),
  status: fc.constantFrom(...(["checking", "awaiting_answer", "answered", "rejected", "ambiguous", "superseded"] as const)),
  question: fc.constant("Which rule applies?"), reason: fc.constant("Not in the repository."), createdAt: iso,
  recipient: fc.option(fc.record({
    id: fc.constantFrom("owner", "product"), alias: fc.constantFrom("Owner", "Product"), roles: fc.constant(["product" as const]),
    areas: fc.constant([]), did: fc.option(fc.constantFrom(...DIDS), { nil: undefined }),
  }), { nil: null }),
  delivery: fc.record({
    kind: fc.constantFrom("inbox" as const, "webhook" as const),
    status: fc.constantFrom("not_sent" as const, "sent" as const, "uncertain" as const),
  }),
});
const inbox: fc.Arbitrary<SpaceInbox> = fc.record({
  trailId: fc.constantFrom(...trailIds), short: fc.constant("T-1"), title: fc.constant("Approve the plan"),
  kind: fc.constantFrom("checkpoint" as const, "spend" as const, "parked" as const, "notice" as const),
  checkpoint: fc.option(fc.constantFrom("A" as const, "B" as const, "C" as const), { nil: undefined }),
  blocking: fc.boolean(), artefact: fc.constant({ path: "plan.md", summary: "Plan" }), createdAt: iso,
  risk: fc.constant("low" as const),
});
const world = fc.record({
  trails, questions: fc.uniqueArray(question, { selector: (q) => q.id, maxLength: 6 }), inbox: fc.array(inbox, { maxLength: 6 }),
});

describe("team space", () => {
  test("every open question and every non-notice inbox entry becomes exactly one ask", () => {
    fc.assert(fc.property(world, (w) => {
      const list = asks(w);
      const open = w.questions.filter((q) => q.status === "awaiting_answer" || q.status === "ambiguous");
      const actionable = w.inbox.filter((e) => e.kind !== "notice");
      expect(list.length).toBe(open.length + actionable.length);
      for (const q of open) expect(list.filter((a) => a.key === `question:${q.id}`)).toHaveLength(1);
      expect(list.some((a) => (a.kind as string) === "notice")).toBe(false);
    }));
  });

  test("blocking asks come first, then the longest wait", () => {
    fc.assert(fc.property(world, (w) => {
      const list = asks(w);
      for (let i = 1; i < list.length; i++) {
        const [a, b] = [list[i - 1]!, list[i]!];
        expect(Number(a.blocking)).toBeGreaterThanOrEqual(Number(b.blocking));
        if (a.blocking === b.blocking) expect(Date.parse(a.since)).toBeLessThanOrEqual(Date.parse(b.since));
      }
    }));
  });

  test("a checkpoint waits on the human owner when there is one, otherwise on approvers", () => {
    fc.assert(fc.property(world, (w) => {
      const byId = new Map(w.trails.map((t) => [t.id, t]));
      for (const a of asks(w).filter((x) => x.kind !== "question")) {
        const owner = byId.get(a.trailId)?.owner;
        expect(a.waitingOn).toEqual(owner?.kind === "human" ? { kind: "person", did: owner.id } : { kind: "approvers" });
      }
    }));
  });

  test("blocker counts add up to the asks, and per-person load matches person asks", () => {
    fc.assert(fc.property(world, (w) => {
      const list = asks(w);
      const rows = blockers(list);
      expect(rows.reduce((n, r) => n + r.count, 0)).toBe(list.length);
      expect(new Set(rows.map((r) => waitingKey(r.waitingOn))).size).toBe(rows.length);
      const people = load(list, w.trails);
      for (const did of DIDS) {
        const waiting = list.filter((a) => a.waitingOn.kind === "person" && a.waitingOn.did === did).length;
        expect(people.get(did)?.waiting ?? 0).toBe(waiting);
      }
    }));
  });

  test("work groups partition open quests; ended quests appear only in the 30-day counts", () => {
    fc.assert(fc.property(trails, (list) => {
      const grouped = workGroups(list).flatMap((g) => g.trails.map((t) => t.id));
      const ended = list.filter((t) => t.state === "closed" || t.state === "abandoned");
      expect(new Set(grouped).size).toBe(grouped.length);
      expect(grouped.length).toBe(list.length - ended.length);
      const counts = recentCounts(list, NOW);
      expect(counts.open).toBe(grouped.length);
      const recent = ended.filter((t) => Date.parse(t.updatedAt) >= NOW - 30 * 86_400_000);
      expect(counts.landed + counts.ended).toBe(recent.length);
    }));
  });

  test("a closed quest without a landing receipt never counts as landed", () => {
    const t: SpaceTrail = { id: "t1", short: "T-1", title: "Q", state: "closed", area: "a", updatedAt: new Date(NOW).toISOString() };
    expect(recentCounts([t], NOW)).toEqual({ landed: 0, ended: 1, open: 0 });
    expect(recentCounts([{ ...t, landing: { receipts: [{}] } }], NOW)).toEqual({ landed: 1, ended: 0, open: 0 });
  });

  test("delivery never reports sent for an uncertain or ambiguous question", () => {
    fc.assert(fc.property(question, (q) => {
      const d = delivery(q);
      if (q.status === "ambiguous" || q.delivery.status === "uncertain") expect(d).toBe("unconfirmed");
      if (q.delivery.status === "not_sent" && q.status !== "ambiguous") expect(d).toBe("not_sent");
    }));
  });

  test("the bridge is connected only with an enabled URL and a saved key", () => {
    const base = { enabled: true, workspaceId: "w", contacts: [], webhookUrl: "https://relay.example.com/q", keyConfigured: true, updatedAt: "x" };
    expect(channelStatus(base).bridge).toBe("connected");
    expect(channelStatus(base).host).toBe("relay.example.com");
    expect(channelStatus({ ...base, keyConfigured: false }).bridge).toBe("incomplete");
    expect(channelStatus({ ...base, webhookUrl: null }).bridge).toBe("incomplete");
    expect(channelStatus({ ...base, enabled: false }).bridge).toBe("off");
    expect(channelStatus(null).bridge).toBe("off");
    expect(channelStatus(undefined).bridge).toBe("unknown");
  });
});
