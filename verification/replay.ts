import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { Trail, ProofBundle } from "../packages/core/src/schemas.ts";
import { TrailEvent, type TransitionContext } from "../packages/core/src/events.ts";
import { transition } from "../packages/core/src/lifecycle.ts";
import { proofDigest } from "../packages/core/src/digest.ts";

type Snapshot = { phase: string; event: string; revision: number; base: number;
  receiptRev: number; receiptBase: number; receiptHead: number };
function parseTrace(input: unknown): Snapshot[] {
  assert(input && typeof input === "object" && "states" in input);
  assert(Array.isArray(input.states) && input.states.length >= 2);
  return input.states.map(raw => {
    assert(raw && typeof raw === "object");
    assert(["proving", "ready", "patching", "landing", "watching", "closed"].includes(raw.phase));
    assert(["init", "proof", "base", "patch", "approve", "land", "watch", "idle"].includes(raw.event));
    const integer = (key: string): number => {
      const value = raw[key]?.["#bigint"];
      assert(typeof value === "string" && /^[0-3]$/.test(value), `Invalid ${key}`);
      return Number(value);
    };
    return { phase: raw.phase, event: raw.event, revision: integer("revision"), base: integer("base"),
      receiptRev: integer("receiptRev"), receiptBase: integer("receiptBase"), receiptHead: integer("receiptHead") };
  });
}
const id = "00000000-0000-4000-8000-000000000001";
const now = "2026-11-12T00:00:00Z";
const sha = (n: number) => n.toString(16).repeat(40);
const ctx: TransitionContext = {
  now, blocking: { A: false, B: false, C: false }, landingModes: ["trail_ref"],
  proofSufficient: true,
};

/** Replay an independently generated Quint ITF trace against the actual reducer.
 * The fixtures assume evidence sufficiency and authenticated events. They do not
 * exercise evidence collection, API authorization, a deployment, or a real watch. */
export function replayTrace(input: unknown): {
  modelSteps: number; reducerEvents: number; stutters: number; completed: boolean; rejectedProofs: number;
} {
  const states = parseTrace(input);
  const initial = states[0]!;
  assert.equal(initial.event, "init");
  assert.equal(initial.phase, "proving");
  assert.equal(initial.revision, 1);
  assert.equal(initial.base, 0);
  let trail = Trail.parse({
    schema: 1, id, short: "T-formal", repo: "fixture", title: "Proof binding model",
    rev: 1, state: "proving", head: sha(1), signals: [id], area: "a", risk: "low",
    route: "auto_fix", severity: 1, base: { ref: "main", sha: sha(0) },
    checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
    budget: { tokensUsed: 0, tokensMax: 1000, wallclockMaxS: 100,
      spendMicrousdUsed: 0, spendMicrousdMax: 1000 },
    mirrors: {}, createdAt: now, updatedAt: now,
  });
  let rejectedProofs = 0;
  let reducerEvents = 0;
  let stutters = 0;
  for (const [i, state] of states.slice(1).entries()) {
    let body: object;
    switch (state.event) {
      case "idle": body = { type: "human_comment", data: { text: "fixture stutter" } }; break;
      case "base": body = { type: "base_moved", data: { newSha: sha(state.base), overlapsTouchedFiles: true } }; break;
      case "patch": body = { type: "patch_completed", data: { revision: state.revision, head: sha(state.revision) } }; break;
      case "proof": {
        const bundle = ProofBundle.parse({ schema: 1, trail: id, rev: state.receiptRev, risk: "low",
          base: sha(state.receiptBase), head: sha(state.receiptHead), items: [], passed: true,
          missing: [], env: { runner: "model-fixture" }, computedAt: now });
        body = { type: "proof_completed", data: { bundle, digest: proofDigest(bundle) } };
        break;
      }
      case "approve": body = { type: "checkpoint_decided", data: { checkpoint: "C",
        decision: { by: "policy", at: now, verdict: "approve", shadow: false } } }; break;
      case "land": body = { type: "landing_completed", data: { receipt: {
        mode: "trail_ref", target: "fixture", oldOid: trail.base.sha, newOid: trail.head, at: now,
      } } }; break;
      case "watch": body = { type: "watch_completed", data: { outcome: "clean" } }; break;
      default: throw new Error("Unexpected init inside trace");
    }
    // Idle represents no event; terminal states correctly reject further comments.
    if (state.event !== "idle") {
      reducerEvents++;
      const event = TrailEvent.parse({ schema: 1, id, trail: id, rev: trail.rev, at: now,
        actor: { kind: "system", id: "formal-fixture" }, ...body });
      const result = transition(trail, event, ctx);
      if (result.ok) {
        const land = result.effects.filter(effect => effect.type === "land");
        const watch = result.effects.filter(effect => effect.type === "start_watch");
        assert.equal(land.length, state.event === "approve" ? 1 : 0, `landing effect at step ${i + 1}`);
        assert.equal(watch.length, state.event === "land" ? 1 : 0, `watch effect at step ${i + 1}`);
        if (land[0]?.type === "land") assert.deepEqual(land[0].modes, ctx.landingModes);
        trail = result.trail;
      }
      else {
        assert.equal(state.event, "proof", `Unexpected rejected ${state.event} at ${i + 1}: ${result.error}`);
        rejectedProofs++;
      }
    } else stutters++;
    assert.equal(trail.state, state.phase, `phase at step ${i + 1}`);
    assert.equal(trail.rev, state.revision, `revision at step ${i + 1}`);
    assert.equal(trail.head, sha(state.revision), `head at step ${i + 1}`);
    assert.equal(trail.base.sha, sha(state.base), `base at step ${i + 1}`);
  }
  return { modelSteps: states.length - 1, reducerEvents, stutters, completed: trail.state === "closed", rejectedProofs };
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  assert(files.length > 0, "Supply generated ITF trace paths");
  const results = [];
  for (const file of files) results.push(replayTrace(JSON.parse(await readFile(file, "utf8"))));
  console.log(JSON.stringify({ traces: results.length,
    modelSteps: results.reduce((sum, r) => sum + r.modelSteps, 0),
    reducerEvents: results.reduce((sum, r) => sum + r.reducerEvents, 0),
    stutters: results.reduce((sum, r) => sum + r.stutters, 0),
    completed: results.filter(r => r.completed).length,
    rejectedProofs: results.reduce((sum, r) => sum + r.rejectedProofs, 0),
    scope: "Quint trace replay against core reducer; no live model, evidence or deployment" }, null, 2));
}
