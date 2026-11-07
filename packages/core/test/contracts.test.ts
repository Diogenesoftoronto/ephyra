import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Signal, Trail, TrailEvent, shortId, uuidv7 } from "../src/index.ts";

describe("ids", () => {
  test("uuidv7 is valid, versioned and time-sortable", () => {
    const ids = Array.from({ length: 200 }, () => uuidv7());
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
  });
  test("uuidv7 encodes the timestamp", () => {
    fc.assert(fc.property(fc.integer({ min: Date.now() + 1e9, max: Date.now() + 2e9 }), (ms) => {
      const id = uuidv7(ms);
      expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBeGreaterThanOrEqual(ms);
    }));
  });
  test("shortId", () => expect(shortId("0193a0b2-7c1d-7e2f-8a3b-4c5d6e7f8a9b")).toBe("T-7f8a9b"));
});

const SHA = "a".repeat(40);
const now = new Date().toISOString();
const trail = {
  schema: 1, id: uuidv7(), short: "T-000000", repo: "voxq", title: "NPE in cart total", rev: 1, state: "sensed",
  signals: [], area: "cart", risk: "medium", route: "auto_fix", severity: 1.5, base: { ref: "refs/heads/main", sha: SHA },
  checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
  budget: { tokensUsed: 0, tokensMax: 2_000_000, wallclockMaxS: 3600, spendMicrousdUsed: 0, spendMicrousdMax: 0 },
  mirrors: {}, createdAt: now, updatedAt: now,
};

describe("schemas", () => {
  test("trail round-trips", () => expect(Trail.parse(trail).id).toBe(trail.id));
  test("event envelope validates body by type", () => {
    const ev = { schema: 1, id: uuidv7(), trail: trail.id, rev: 1, at: now, actor: { kind: "human", id: "kmannoel" },
      type: "checkpoint_decided", data: { checkpoint: "A", decision: { by: "human", at: now, verdict: "approve" } } };
    expect(TrailEvent.parse(ev).type).toBe("checkpoint_decided");
    expect(() => TrailEvent.parse({ ...ev, data: { checkpoint: "Z" } })).toThrow();
  });
  test("signal requires a fingerprint", () => {
    expect(() => Signal.parse({ schema: 1, id: uuidv7(), kind: "error", repo: "r", fingerprint: "x", title: "t", message: "m", firstSeen: now, lastSeen: now, count: 1, source: "otlp" })).toThrow();
  });
});
