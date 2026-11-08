import { expect, test } from "bun:test";
import fc from "fast-check";
import { accountUsage, budgetBlocker, Trail, TrailEvent, transition, type Budget } from "../src/index.ts";

const budget: Budget = {
  tokensUsed: 0, tokensMax: 100, spendMicrousdUsed: 0, spendMicrousdMax: 1000, wallclockMaxS: 60,
};
const id = "00000000-0000-4000-8000-000000000001";
const now = "2026-11-08T00:00:00.000Z";
const trail = Trail.parse({ schema: 1, id, short: "T-test", repo: "repo", title: "test", rev: 1,
  state: "patching", signals: [], area: "application", risk: "medium", route: "auto_fix", severity: 1,
  base: { ref: "refs/heads/main", sha: "a".repeat(40) }, checkpoints: { spend: [] },
  attempts: { proof: 0, maxProof: 3 }, budget, createdAt: now, updatedAt: now });

test("usage sums are independent of receipt order and unknown values remain explicit", () => {
  const receipt = fc.record({ tokens: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }),
    costMicrousd: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }), wallMs: fc.integer({ min: 0, max: 1000 }) });
  fc.assert(fc.property(fc.array(receipt, { maxLength: 100 }), (receipts) => {
    const total = receipts.reduce(accountUsage, budget);
    expect([...receipts].reverse().reduce(accountUsage, budget)).toEqual(total);
    expect(total.tokensUsed).toBe(receipts.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0));
    expect(total.unknownCostEntries ?? 0).toBe(receipts.filter((entry) => entry.costMicrousd === null).length);
    expect(total.unknownTokenEntries ?? 0).toBe(receipts.filter((entry) => entry.tokens === null).length);
    expect(budget.tokensUsed).toBe(0);
  }));
});

test("budget crossing parks the workflow and stops the real executor", () => {
  const event = TrailEvent.parse({ schema: 1, id, trail: id, rev: 1, at: now, actor: { kind: "system", id: "usage" },
    type: "usage_recorded", data: { operationKey: "turn-1", tokens: 101, costMicrousd: 3, wallMs: 100 } });
  const context = { now, blocking: { A: false, B: false, C: false }, landingModes: ["auto_land" as const] };
  const result = transition(trail, event, context);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.trail.state).toBe("parked");
  expect(result.trail.budget.tokensUsed).toBe(101);
  expect(result.effects.some((effect) => effect.type === "stop_agent")).toBe(true);
  const killed = transition({ ...trail, state: "abandoned" }, event, context);
  expect(killed.ok && killed.trail.state).toBe("abandoned");
  expect(killed.ok && killed.trail.budget.tokensUsed).toBe(101);
  expect(killed.ok && killed.effects).toEqual([]);
});

test("unknown paid usage and observed execution time cannot silently reset limits", () => {
  const unknown = accountUsage({ ...budget, requireKnownCost: true }, { tokens: 4, costMicrousd: null, wallMs: 0 });
  expect(budgetBlocker(unknown)).toContain("Spending is unknown");
  expect(budgetBlocker(accountUsage(budget, { tokens: null, costMicrousd: 0, wallMs: 0 }))).toContain("Token usage is unknown");
  expect(budgetBlocker(accountUsage(budget, { tokens: 0, costMicrousd: 0, wallMs: 60_000 }))).toContain("execution-time");
  expect(() => accountUsage(budget, { tokens: -1, costMicrousd: null, wallMs: 0 })).toThrow();
});

test("an owned human revision cannot finish proof after exhausting its budget", () => {
  const owned = { ...trail, state: "handed_off" as const, resumeTo: "proving" as const,
    owner: { kind: "human" as const, id: "did:example:reviewer" } };
  const event = TrailEvent.parse({ schema: 1, id, trail: id, rev: 1, at: now, actor: { kind: "system", id: "usage" },
    type: "usage_recorded", data: { operationKey: "review-turn", tokens: 101, costMicrousd: 3, wallMs: 100 } });
  const result = transition(owned, event, { now, blocking: { A: true, B: true, C: true }, landingModes: ["trail_ref"] });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.trail.state).toBe("parked");
  expect(result.trail.owner).toBeUndefined();
  expect(result.trail.resumeTo).toBe("proving");
  expect(result.effects.some(effect => effect.type === "stop_agent")).toBe(true);
});
