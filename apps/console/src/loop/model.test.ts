import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  Effect, TrailEventBody, TrailState, createTrail, transition,
  type Actor, type Trail, type TrailEvent, type TrailEventBody as Body,
} from "@ephyra/core";
import {
  ATTENTION, ATTENTION_GROUP, LOOP_STAGES, STAGE_IDS, byAttention, describeEffect, fleetView, journeyOf, loopPoint, narrate,
  parseRecovery, progressOf, questView, stageOf, watchProgress, type InboxLike, type QuestView,
} from "./model.ts";
import { QUESTS, REPO, VIEWER, moves, timelines, worldAt, type Make } from "./scenario.ts";

const STATES = TrailState.options;
const script = QUESTS[0]!;
const SHA = "a".repeat(40);

describe("the loop is a shape, not a list", () => {
  test("every state has a place in the loop", () => {
    fc.assert(fc.property(fc.constantFrom(...STATES), fc.option(fc.constantFrom(...STATES), { nil: undefined }), (state, resumeTo) => {
      const at = stageOf({ state, resumeTo });
      expect(STAGE_IDS).toContain(at.id);
      const progress = progressOf({ state, resumeTo });
      expect(progress).toBeGreaterThan(0);
      expect(progress).toBeLessThanOrEqual(1);
      const point = loopPoint(progress);
      expect(point.depth).toBeGreaterThanOrEqual(0);
      expect(point.depth).toBeLessThanOrEqual(1);
    }));
  });

  test("a held quest stays where it would resume", () => {
    fc.assert(fc.property(fc.constantFrom("parked" as const, "handed_off" as const), fc.constantFrom(...STATES), (held, resumeTo) => {
      expect(stageOf({ state: held, resumeTo }).id).toBe(stageOf({ state: resumeTo, resumeTo }).id);
    }));
  });

  test("the loop sinks from production to the code, then rises back", () => {
    const depths = LOOP_STAGES.map((stage) => stage.depth);
    const deepest = depths.indexOf(Math.max(...depths));
    for (let i = 1; i <= deepest; i++) expect(depths[i]!).toBeGreaterThanOrEqual(depths[i - 1]!);
    for (let i = deepest + 1; i < depths.length; i++) expect(depths[i]!).toBeLessThanOrEqual(depths[i - 1]!);
    expect(depths[0]).toBe(0);
    expect(depths.at(-1)).toBe(0);
  });

  test("the path has no jumps and survives bad numbers", () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (p) => {
      const a = loopPoint(p);
      const b = loopPoint(Math.min(1, p + 0.01));
      expect(Math.abs(a.depth - b.depth)).toBeLessThan(0.05);
    }));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -4, 9]) {
      const point = loopPoint(bad);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
    }
  });

  test("progress never runs backwards along the forward states", () => {
    const forward: TrailState[] = [
      "sensed", "triaged", "researching", "hypothesised", "reproducing", "planned", "patching", "proving", "ready", "landing",
      "watching", "closed",
    ];
    const values = forward.map((state) => progressOf({ state }));
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
  });
});

// ───────────────────────── Random walks through the real machine ─────────────────────────

type Walk = { trail: Trail; events: TrailEvent[]; view: QuestView };
const human: Actor = { kind: "human", id: VIEWER };
const decide = (verdict: "approve" | "revise" | "reject"): Make => (trail, at) => ({
  type: "checkpoint_decided", data: {
    checkpoint: trail.state === "hypothesised" ? "A" : trail.state === "planned" ? "B" : "C",
    decision: { by: "human", who: VIEWER, at, verdict, ...(verdict === "revise" ? { note: "Try another way." } : {}) },
  },
});
const MOVES: { make: Make; actor?: Actor }[] = [
  { make: moves.research() }, { make: moves.repro() }, { make: moves.reproFailed("Could not make it fail.") }, { make: moves.plan() },
  { make: moves.patch() }, { make: moves.proof(true) }, { make: moves.proof(false, ["repro_after"]) }, { make: moves.landed() },
  { make: moves.watch() }, { make: moves.clean() }, { make: moves.regressed("error rate doubled", "minute 3") },
  { make: moves.rolledBack() }, { make: moves.failed("patch", "The engine crashed.") }, { make: moves.failed("repro", "Timed out.") },
  { make: decide("approve"), actor: human }, { make: decide("approve"), actor: human }, { make: decide("revise"), actor: human },
  { make: decide("reject"), actor: human },
  { make: () => ({ type: "parked", data: { reason: "A person paused it." } }), actor: human },
  { make: () => ({ type: "resumed", data: {} }), actor: human },
  { make: () => ({ type: "killed", data: { reason: "Not worth fixing." } }), actor: human },
  { make: () => ({ type: "claimed_by_human", data: {} }), actor: human },
  { make: () => ({ type: "released_by_human", data: {} }), actor: human },
  { make: () => ({ type: "land_requested", data: {} }), actor: human },
  { make: () => ({ type: "base_moved", data: { newSha: "b".repeat(40), overlapsTouchedFiles: true } }) },
];
const GATE = { hypothesised: "A", planned: "B", ready: "C" } as const;

// What each state is waiting for, weighted towards moving on. A negative pick asks for one of these.
const NEXT: Partial<Record<TrailState, number[]>> = {
  researching: [0], hypothesised: [14, 14, 14, 16], reproducing: [1, 3, 1, 3, 2], planned: [14, 14, 14, 16], patching: [4, 4, 12],
  proving: [5, 5, 6], ready: [14, 14, 14, 16], landing: [7], watching: [8, 9, 10, 10], rolled_back: [11], parked: [19], handed_off: [22],
};

/** Apply random facts to a fresh quest. The machine refuses most; what it accepts is a real history. */
function walk(picks: readonly number[], blocking: boolean): Walk[] {
  const at = (n: number) => new Date(Date.UTC(2026, 10, 10, 14, 0, n)).toISOString();
  const timeline = timelines()[0]!;
  const made = createTrail({
    id: timeline.id, signal: timeline.signal, title: script.title, repo: REPO, base: { ref: "main", sha: SHA },
    triage: timeline.triage, now: at(0),
    budget: { tokensUsed: 0, tokensMax: 1_000_000, wallclockMaxS: 3600, spendMicrousdUsed: 0, spendMicrousdMax: 5_000_000 },
  });
  let trail = made.trail!;
  // The server journals triage as the first event of every quest (wiring/intake.ts); the walk starts the same way.
  const events: TrailEvent[] = [timeline.frames[0]!.event];
  const out: Walk[] = [];
  picks.forEach((pick, index) => {
    const wanted = NEXT[trail.state];
    const move = MOVES[pick < 0 && wanted ? wanted[-pick % wanted.length]! : Math.abs(pick) % MOVES.length]!;
    const body: Body = move.make(trail, at(index + 1), script);
    const event = {
      schema: 1, id: `0193a0e0-0000-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`, trail: trail.id, rev: trail.rev,
      at: at(index + 1), actor: move.actor ?? { kind: "system", id: "test" }, ...body,
    } as TrailEvent;
    const policy = { by: "policy" as const, at: at(index + 1), verdict: "approve" as const, backend: "test/decide" };
    const result = transition(trail, event, {
      now: at(index + 1), blocking: { A: blocking, B: blocking, C: blocking }, landingModes: ["auto_land"],
      ...(blocking ? {} : { autoDecision: { A: policy, B: policy, C: policy } }),
    });
    if (!result.ok) return;
    trail = result.trail;
    events.push(event);
    const gate = GATE[trail.state as keyof typeof GATE];
    const inbox: InboxLike[] = gate && blocking ? [{ trailId: trail.id, kind: "checkpoint", checkpoint: gate, blocking: true }] : [];
    out.push({ trail, events: [...events], view: questView({ trail, events, inbox, viewer: VIEWER }) });
  });
  return out;
}

const picks = fc.array(fc.nat({ max: 999 }), { minLength: 1, maxLength: 60 });
// Most random facts are refused, so two picks in three ask for a fact the current state is waiting for.
const guided = fc.array(fc.oneof({ weight: 2, arbitrary: fc.integer({ min: -999, max: -1 }) }, { weight: 1, arbitrary: fc.nat({ max: 999 }) }),
  { minLength: 10, maxLength: 80 });
const guidedWalk = walk;

describe("any history the machine accepts can be shown", () => {
  test("the view never throws and never contradicts the machine", () => {
    fc.assert(fc.property(guided, fc.boolean(), (raw, blocking) => {
      for (const { trail, view } of guidedWalk(raw, blocking)) {
        expect(ATTENTION).toContain(view.attention);
        expect(view.group).toBe(ATTENTION_GROUP[view.attention]);
        expect(view.stage.id).toBe(stageOf(trail).id);
        expect(view.headline.length).toBeGreaterThan(0);
        if (trail.state === "closed") expect(view.attention).toBe("set");
        if (trail.state === "abandoned") expect(view.attention).toBe("dropped");
        if (trail.state === "rolled_back") expect(view.attention).toBe("reverted");
        if (view.attention === "needs_you") expect(view.action).not.toBeNull();
        if (view.action) expect(["you", "stopped"]).toContain(view.group);
        if (view.group === "finished") expect(view.action).toBeNull();
      }
    }), { numRuns: 120 });
  });

  test("a blocking checkpoint always reaches the person, and only then", () => {
    fc.assert(fc.property(guided, (raw) => {
      for (const { trail, view } of guidedWalk(raw, true)) {
        const gate = GATE[trail.state as keyof typeof GATE];
        if (gate) expect(view.action).toEqual({ kind: "decide", checkpoint: gate, label: view.action!.label });
        else if (view.action) expect(view.action.kind).not.toBe("decide");
      }
    }), { numRuns: 80 });
  });

  test("the journey ends where the machine says the quest is", () => {
    fc.assert(fc.property(guided, fc.boolean(), (raw, blocking) => {
      const history = guidedWalk(raw, blocking);
      for (const { trail, events } of history) {
        const journey = journeyOf(events, trail);
        expect(journey.length).toBeGreaterThanOrEqual(events.length);
        expect(journey.filter((step) => step.event !== null).map((step) => step.event)).toEqual(events.map((event) => event.id));
        const held = trail.state === "parked" || trail.state === "handed_off" || trail.state === "abandoned";
        if (!held) expect(journey.at(-1)?.stage ?? "signal").toBe(stageOf(trail).id);
        const rollbacks = events.filter((event) => event.type === "rollback_completed").length;
        expect(journey.at(-1)?.lap ?? 1).toBe(1 + rollbacks);
      }
    }), { numRuns: 120 });
  });

  test("with every checkpoint blocking, the events alone place the quest", () => {
    // No policy decision is implied, so the journey needs no catch-up step to reach the machine's stage.
    fc.assert(fc.property(guided, (raw) => {
      for (const { trail, events } of guidedWalk(raw, true)) {
        const held = trail.state === "parked" || trail.state === "handed_off" || trail.state === "abandoned";
        if (held) continue;
        expect(journeyOf(events).at(-1)?.stage).toBe(stageOf(trail).id);
        expect(journeyOf(events).some((step) => step.type === "implied")).toBe(false);
      }
    }), { numRuns: 120 });
  });

  test("a failed proof shows as a step back, or as a stop when it was the last one allowed", () => {
    // Three failed proofs in a row: the first two send the quest back to patching, the third stops it where it is.
    const exhausted = [-1, -1, -1, -180, -1, 0, -311, -1, -329, 0, 0, 0, -1, -488, -1];
    fc.assert(fc.property(guided, (raw) => {
      const history = guidedWalk(raw, true);
      const last = history.at(-1);
      if (!last) return;
      const steps = new Map(journeyOf(last.events, last.trail).map((step) => [step.event, step.kind]));
      let back = 0;
      for (const { trail, events } of history) {
        const event = events.at(-1)!;
        if (event.type === "rollback_completed") {
          expect(steps.get(event.id)).toBe("retreat");
          back++;
        }
        if (event.type !== "proof_completed" || event.data.bundle.passed) continue;
        const stopped = trail.state === "parked";
        expect(steps.get(event.id)).toBe(stopped ? "hold" : "retreat");
        if (!stopped) back++;
      }
      expect(last.view.retreats).toBeGreaterThanOrEqual(back);
    }), { numRuns: 200, examples: [[exhausted]] });
  });

  test("random walks really do reach the far end of the loop", () => {
    const reached = new Set<TrailState>();
    fc.assert(fc.property(guided, (raw) => {
      for (const { trail } of guidedWalk(raw, true)) reached.add(trail.state);
    }), { numRuns: 200, seed: 7 });
    for (const state of ["ready", "landing", "watching", "closed", "rolled_back", "parked", "abandoned", "handed_off"] as const) {
      expect(reached).toContain(state);
    }
  });

  test("unguided noise is survived too", () => {
    fc.assert(fc.property(picks, fc.boolean(), (raw, blocking) => {
      for (const { view } of walk(raw, blocking)) expect(ATTENTION).toContain(view.attention);
    }), { numRuns: 60 });
  });
});

describe("who holds the next move", () => {
  const views = fc.integer({ min: 0, max: 240 }).map((tick) => worldAt(tick).views);

  test("the fleet sentence counts every quest once", () => {
    fc.assert(fc.property(views, (quests) => {
      const fleet = fleetView(quests);
      expect(Object.values(fleet.counts).reduce((sum, n) => sum + n, 0)).toBe(quests.length);
      expect(Object.values(fleet.groups).reduce((sum, n) => sum + n, 0)).toBe(quests.length);
      expect(/needs? you/.test(fleet.sentence)).toBe(fleet.groups.you > 0);
      expect(/stopped/.test(fleet.sentence)).toBe(fleet.groups.stopped > 0);
      expect(fleet.focus === null).toBe(quests.every((quest) => quest.group === "finished"));
    }));
  });

  test("the order a person scans in does not depend on the order quests arrive in", () => {
    fc.assert(fc.property(views.chain((quests) => fc.tuple(fc.constant(quests), fc.shuffledSubarray(quests, { minLength: quests.length }))),
      ([quests, shuffled]) => {
        expect([...shuffled].sort(byAttention).map((quest) => quest.id)).toEqual([...quests].sort(byAttention).map((quest) => quest.id));
      }));
  });

  test("what needs a person sorts ahead of what does not", () => {
    fc.assert(fc.property(views, (quests) => {
      const groups = [...quests].sort(byAttention).map((quest) => quest.group);
      const firstOther = groups.findIndex((group) => group !== "you");
      if (firstOther >= 0) expect(groups.slice(firstOther)).not.toContain("you");
    }));
  });

  test("an empty workspace is quiet, not broken", () => {
    expect(fleetView([]).sentence).toBe("Nothing is in flight. Production is quiet.");
    expect(fleetView([]).focus).toBeNull();
  });

  test("nothing is addressed to you when nobody is signed in", () => {
    const world = worldAt(110);
    for (const entry of world.quests) {
      const anonymous = questView({ trail: entry.trail, events: entry.events, questions: entry.questions, inbox: [] });
      expect(anonymous.attention).not.toBe("needs_you");
    }
  });

  test("a watched quest reports how far through its window it is", () => {
    const entry = worldAt(160).quests.find((quest) => quest.script.hex === "7f3a2c")!;
    const watch = watchProgress(entry.trail, entry.events, worldAt(160).at)!;
    expect(watch.windowS).toBe(900);
    expect(watch.elapsedS).toBe((160 - 138) * 15);
    expect(watchProgress({ state: "patching" }, entry.events, worldAt(160).at)).toBeNull();
  });
});

describe("plain words for everything under the hood", () => {
  const seen = new Map<string, TrailEvent>();
  const effects = new Map<string, Effect>();
  for (const injected of [[], [{ quest: timelines()[2]!.id, tick: 112, action: "approve" as const }]]) {
    for (const timeline of timelines(injected)) {
      for (const frame of timeline.frames) {
        seen.set(frame.event.type, frame.event);
        for (const effect of frame.effects) effects.set(effect.type, effect);
      }
    }
  }
  const envelope = { schema: 1, id: "0193a0e0-0000-7000-8000-000000000001", trail: timelines()[0]!.id, rev: 1, at: "2026-11-10T14:00:00.000Z",
    actor: { kind: "system", id: "test" } };
  const extra: Body[] = [
    { type: "trail_created", data: { signalId: timelines()[0]!.signal.id, title: "A title", baseRef: "main", baseSha: SHA } },
    { type: "land_requested", data: {} },
    { type: "landing_failed", data: { reason: "The forge refused the push.", baseMoved: false } },
    { type: "base_moved", data: { newSha: SHA, overlapsTouchedFiles: true } },
    { type: "human_comment", data: { text: "Please also cover refunds.", isRequest: true } },
    { type: "claimed_by_human", data: {} },
    { type: "human_revision", data: { head: SHA } },
    { type: "released_by_human", data: {} },
    { type: "killed", data: { reason: "Not worth fixing." } },
    { type: "budget_exceeded", data: { summary: "Token budget spent." } },
    { type: "spend_requested", data: { purpose: "Ask five users", microusd: 2_000_000 } },
    { type: "spend_decided", data: { decision: { by: "human", who: VIEWER, at: envelope.at, verdict: "approve" } } },
    { type: "child_trail_finished", data: { child: timelines()[1]!.id, proofDigest: `sha256:${"0".repeat(64)}` } },
    { type: "parent_trail_landed", data: { parent: timelines()[1]!.id } },
    { type: "intent_updated", data: { intent: "refund-split-tender" } },
    { type: "policy_updated", data: { commit: SHA, path: "AUTONOMY.md" } },
    { type: "mirror_linked", data: { kind: "tangledUri", id: "at://did:plc:example/sh.tangled.repo.pull/42" } },
  ];
  for (const body of extra) {
    const parsed = TrailEventBody.safeParse(body);
    if (!parsed.success) throw new Error(`The sample for ${body.type} is not a valid event: ${parsed.error.message}`);
    if (!seen.has(body.type)) seen.set(body.type, { ...envelope, ...parsed.data } as TrailEvent);
  }

  test("every event type has wording that is not its type name", () => {
    const types = TrailEventBody.options.map((option) => option.shape.type.value as string);
    expect(types.filter((type) => !seen.has(type))).toEqual([]);
    for (const [type, event] of seen) {
      const text = narrate(event);
      expect(text.length).toBeGreaterThan(8);
      expect(text).not.toContain(type);
      expect(text).not.toMatch(/undefined|\[object/);
    }
  });

  test("every effect the machine asked for has wording that is not its type name", () => {
    expect(effects.size).toBeGreaterThanOrEqual(9);
    for (const [type, effect] of effects) {
      const text = describeEffect(effect);
      expect(text.length).toBeGreaterThan(8);
      expect(text).not.toContain(type);
      expect(text).not.toMatch(/undefined|\[object/);
    }
  });
});

describe("recovery attempts are read, never guessed", () => {
  const good = { schema: 1, trail: "t", rev: 2, step: "patch", attempt: 2, maxAttempts: 3, strategy: "alternate_hypothesis", exhausted: false,
    reason: null };
  const file = (path: string, value: unknown) => ({ path, content: typeof value === "string" ? value : JSON.stringify(value) });

  test("files that are unreadable, misnamed or disagree with their path are skipped", () => {
    const files = [
      file("artefacts/recovery/patch-2-2.json", good),
      file("artefacts/recovery/patch-2-3.json", good),
      file("artefacts/recovery/plan-2-2.json", good),
      file("artefacts/recovery/patch-2-1.json", "{not json"),
      file("artefacts/recovery/patch-9-9.json", { ...good, rev: 9, attempt: 9, strategy: "guess_wildly" }),
      file("hypothesis.md", good),
      { path: "artefacts/recovery/patch-1-1.json", content: null },
    ];
    expect(parseRecovery(files).map((entry) => `${entry.step}-${entry.rev}-${entry.attempt}`)).toEqual(["patch-2-2"]);
  });

  test("attempts come back in the order they were made, whatever order the files arrive in", () => {
    const attempt = fc.record({ rev: fc.integer({ min: 1, max: 5 }), attempt: fc.integer({ min: 1, max: 5 }) });
    fc.assert(fc.property(fc.uniqueArray(attempt, { selector: (entry) => `${entry.rev}-${entry.attempt}`, maxLength: 12 }), (entries) => {
      const files = entries.map((entry) => file(`artefacts/recovery/patch-${entry.rev}-${entry.attempt}.json`, { ...good, ...entry }));
      const parsed = parseRecovery(files);
      expect(parsed.length).toBe(entries.length);
      for (let i = 1; i < parsed.length; i++) {
        const a = parsed[i - 1]!;
        const b = parsed[i]!;
        expect(a.rev < b.rev || (a.rev === b.rev && a.attempt < b.attempt)).toBe(true);
      }
    }));
  });
});
