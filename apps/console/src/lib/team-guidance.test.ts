import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { AutonomyLevel, type AreaSketch, type Decision } from "@ephyra/core";
import { guidance, nextLevel, patterns, RAISE_AFTER, record, type GuidanceTrail } from "./team-guidance.ts";
import type { Ask } from "./team-space.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const AREAS = ["payments", "cart", "search"] as const;
const decision: fc.Arbitrary<Decision> = fc.record({
  by: fc.constantFrom("policy" as const, "human" as const),
  at: fc.integer({ min: NOW - 40 * 86_400_000, max: NOW }).map((t) => new Date(t).toISOString()),
  verdict: fc.constantFrom("approve" as const, "revise" as const, "reject" as const),
  note: fc.option(fc.constantFrom("", "Keep the coupon rule", "Too broad"), { nil: undefined }),
  shadow: fc.option(fc.boolean(), { nil: undefined }),
});
const trail: fc.Arbitrary<GuidanceTrail> = fc.record({
  id: fc.uuid(), area: fc.constantFrom(...AREAS), risk: fc.constantFrom("low" as const, "medium" as const, "high" as const, "critical" as const),
  route: fc.constantFrom("auto_fix" as const, "research_only" as const, "human" as const), state: fc.constant("planned" as const),
  checkpoints: fc.record({
    A: fc.option(decision, { nil: undefined }), B: fc.option(decision, { nil: undefined }), C: fc.option(decision, { nil: undefined }),
    spend: fc.array(decision, { maxLength: 2 }),
  }),
  budget: fc.record({ tokensUsed: fc.nat(), tokensMax: fc.nat(), spendMicrousdUsed: fc.nat(5_000_000), spendMicrousdMax: fc.nat(5_000_000) }),
  attempts: fc.record({ proof: fc.nat(3), maxProof: fc.integer({ min: 1, max: 3 }) }),
});
const sketches: fc.Arbitrary<AreaSketch[]> = fc.uniqueArray(fc.record({
  name: fc.constantFrom(...AREAS), intent: fc.constant(""), paths: fc.constant([]), risk: fc.constant("medium" as const),
  level: fc.constantFrom(...AutonomyLevel.options), userFacing: fc.boolean(),
}), { selector: (s) => s.name });
const checkpointAsk = (trailId: string, cp: "A" | "B" | "C", blocking: boolean): Ask => ({
  key: `checkpoint:${trailId}:${cp}`, kind: "checkpoint", trailId, short: "T-1", title: "Review", detail: "", blocking,
  since: new Date(NOW).toISOString(), checkpoint: cp, waitingOn: { kind: "approvers" },
});

describe("team guidance", () => {
  test("only a person's non-shadow decisions count toward the record", () => {
    fc.assert(fc.property(fc.array(trail, { maxLength: 8 }), fc.constantFrom(...AREAS), fc.constantFrom("A" as const, "B" as const, "C" as const),
      (trails, area, cp) => {
        const r = record(trails, area, cp);
        const human = trails.filter((t) => t.area === area).map((t) => t.checkpoints[cp]).filter((d) => d && d.by === "human" && !d.shadow);
        expect(r.approved + r.changed).toBe(human.length);
      }));
  });

  test("raising autonomy is suggested only after enough clean approvals and never after a change", () => {
    fc.assert(fc.property(fc.array(trail, { maxLength: 12 }), sketches, fc.constantFrom("A" as const, "B" as const, "C" as const), fc.boolean(),
      (trails, sk, cp, blocking) => {
        const t = trails[0];
        if (!t) return;
        const g = guidance(checkpointAsk(t.id, cp, blocking), { trail: t, trails, sketches: sk });
        const r = record(trails, t.area, cp);
        const sketch = sk.find((s) => s.name === t.area);
        const raise = g.steps.some((s) => s.id === "raise");
        expect(raise).toBe(Boolean(sketch && nextLevel(sketch.level) && r.changed === 0 && r.approved >= RAISE_AFTER));
        expect(g.why.some((w) => w.includes(blocking ? "blocking" : "advisory"))).toBe(true);
        expect(g.notAlone.length).toBeGreaterThan(0);
      }));
  });

  test("an unreadable policy is said plainly, never presented as a level", () => {
    fc.assert(fc.property(trail, (t) => {
      const g = guidance(checkpointAsk(t.id, "B", true), { trail: t, trails: [t], sketches: undefined });
      expect(g.why[0]).toContain("could not be read");
      expect(g.steps.some((s) => s.id === "raise")).toBe(false);
    }));
  });

  test("a spend ask always says the cap needs a person and offers a budget raise only on a clean record", () => {
    fc.assert(fc.property(fc.array(trail, { minLength: 1, maxLength: 8 }), (trails) => {
      const t = trails[0]!;
      const ask: Ask = { key: "s", kind: "spend", trailId: t.id, short: null, title: "Spend", detail: "", blocking: true,
        since: new Date(NOW).toISOString(), waitingOn: { kind: "approvers" } };
      const g = guidance(ask, { trail: t, trails });
      const r = record(trails, t.area, "spend");
      expect(g.notAlone).toContain("cap");
      expect(g.steps.some((s) => s.id === "budget")).toBe(r.approved >= 3 && r.changed === 0);
    }));
  });

  test("a question to a contact without an account suggests inviting them and the bridge when it is not connected", () => {
    const ask: Ask = { key: "q", kind: "question", trailId: "t", short: null, title: "Q", detail: "Missing rule", blocking: true,
      since: new Date(NOW).toISOString(), delivery: "bridge", waitingOn: { kind: "contact", id: "p", alias: "Product" } };
    const ids = guidance(ask, { trails: [], bridge: "off" }).steps.map((s) => s.id);
    expect(ids).toEqual(["intent", "invite", "bridge", "knowledge"]);
    const connected = guidance(ask, { trails: [], bridge: "connected" }).steps.map((s) => s.id);
    expect(connected).not.toContain("bridge");
  });

  test("patterns count every open ask with a known quest once", () => {
    fc.assert(fc.property(fc.uniqueArray(trail, { selector: (t) => t.id, maxLength: 8 }), sketches, (trails, sk) => {
      const asks = trails.map((t) => checkpointAsk(t.id, "C", true));
      const rows = patterns(asks, new Map(trails.map((t) => [t.id, t])), trails, sk, NOW);
      expect(rows.reduce((n, r) => n + r.open, 0)).toBe(asks.length);
      for (const r of rows) if (r.changed > 0 && r.level && nextLevel(r.level)) expect(r.move).toContain("intent first");
    }));
  });
});
