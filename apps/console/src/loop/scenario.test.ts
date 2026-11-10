import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { AgentRun, AgentRunEvent, InvestigationQuestion, Signal, Trail, TrailEvent, TriageResult, proofDigest } from "@ephyra/core";
import { journeyOf, parseRecovery } from "./model.ts";
import {
  HERO_TICK, LAST_TICK, QUESTS, VIEWER, buildTimeline, nowLine, runEventsAt, timelines, worldAt, type Injected,
} from "./scenario.ts";

const id = (hex: string) => `0193a000-0000-7000-8000-000000${hex}`;
const quest = (tick: number, hex: string, injected: Injected[] = []) => {
  const found = worldAt(tick, injected).quests.find((entry) => entry.script.hex === hex);
  if (!found) throw new Error(`${hex} has not started at tick ${tick}`);
  return found;
};

describe("the simulated hour is the real state machine, not a story", () => {
  test("the state machine accepts every scripted fact", () => {
    for (const timeline of timelines()) expect(timeline.errors).toEqual([]);
  });

  test("every record has the shape the server would return", () => {
    for (const timeline of timelines()) {
      expect(Signal.safeParse(timeline.signal).success).toBe(true);
      expect(TriageResult.safeParse(timeline.triage).success).toBe(true);
      for (const frame of timeline.frames) {
        expect(TrailEvent.safeParse(frame.event).success).toBe(true);
        expect(Trail.safeParse(frame.trail).success).toBe(true);
      }
    }
    for (const tick of [0, 48, HERO_TICK, 152, LAST_TICK]) {
      for (const entry of worldAt(tick).quests) {
        for (const run of entry.runs) expect(AgentRun.safeParse(run).success).toBe(true);
        for (const question of entry.questions) expect(InvestigationQuestion.safeParse(question).success).toBe(true);
      }
    }
  });

  test("event ids are unique, ordered, and chained to their parent", () => {
    const seen = new Set<string>();
    for (const timeline of timelines()) {
      timeline.frames.forEach((frame, index) => {
        expect(seen.has(frame.event.id)).toBe(false);
        seen.add(frame.event.id);
        if (index > 0) {
          const previous = timeline.frames[index - 1]!;
          expect(frame.event.parent).toBe(previous.event.id);
          expect(frame.event.at >= previous.event.at).toBe(true);
          expect(frame.tick >= previous.tick).toBe(true);
        }
      });
    }
  });

  test("proof bundles carry a true digest and say no runner executed them", () => {
    let proofs = 0;
    for (const timeline of timelines()) {
      for (const { event } of timeline.frames) {
        if (event.type !== "proof_completed") continue;
        proofs++;
        expect(event.data.digest).toBe(proofDigest(event.data.bundle));
        expect(event.data.bundle.env.runner).toBe("fixture/no-execution");
      }
    }
    expect(proofs).toBeGreaterThan(8);
  });

  test("building twice gives the same hour", () => {
    QUESTS.forEach((script, index) => {
      expect(buildTimeline(script, index).frames).toEqual(buildTimeline(script, index).frames);
    });
  });

  test("each finished agent run is accounted exactly once", () => {
    for (const timeline of timelines()) {
      const usage = timeline.frames.flatMap(({ event }) => (event.type === "usage_recorded" ? [event.data] : []));
      const finished = timeline.runs.filter((run) => run.end !== undefined && usage.some((u) => u.operationKey === `run:${run.id}`));
      expect(new Set(usage.map((u) => u.operationKey)).size).toBe(usage.length);
      expect(finished.length).toBe(usage.length);
      const tokens = usage.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
      expect(timeline.frames.at(-1)!.trail.budget.tokensUsed).toBe(tokens);
    }
  });
});

describe("the moment the lab opens on", () => {
  const world = worldAt(HERO_TICK);
  const attention = Object.fromEntries(world.quests.map((entry) => [entry.script.hex, entry.view.attention]));

  test("one of everything a person needs to tell apart", () => {
    expect(attention).toEqual({
      "7f3a2c": "recovering", b41e07: "asking", c0ffee: "needs_you", d1a905: "reverted", e5cafe: "set",
      f00d42: "self", "9a11ed": "held",
    });
    expect(world.fleet.sentence).toBe(
      "4 quests are moving by themselves (1 recovering, 1 asking someone, 1 rolling back). 1 needs you. 1 is stopped.",
    );
    expect(world.fleet.focus).toBe(id("c0ffee"));
  });

  test("the recovering quest shows three attempts and three different strategies", () => {
    const { view } = quest(HERO_TICK, "7f3a2c");
    expect(view.ladder.map((entry) => entry.strategy)).toEqual(["initial", "alternate_hypothesis", "fresh_context"]);
    expect(view.ladder.at(-1)!.current).toBe(true);
    expect(view.ladder.at(-1)!.observations).toEqual(["Missing proof: regression_probes"]);
    expect(view.retreats).toBe(2);
  });

  test("the asking quest shows the question, who it went to, why them, and the check that passed it", () => {
    const { view } = quest(HERO_TICK, "b41e07");
    expect(view.headline).toBe("Asking Sam");
    expect(view.question).toMatchObject({ status: "awaiting_answer", to: "Sam", toYou: false, because: "operator for billing" });
    expect(view.question!.checks).toEqual([{ phase: "question", model: "judgement-jev/jev-1.14", accepted: true }]);
    expect(view.action).toBeNull();
  });

  test("the quest that needs you has exactly one action, and nothing else asks for you", () => {
    const actions = world.views.filter((view) => view.action !== null);
    expect(actions.map((view) => view.action)).toEqual([{ kind: "decide", checkpoint: "C", label: "Approve landing" }]);
    expect(actions[0]!.id).toBe(id("c0ffee"));
  });

  test("the stopped quest ran out of approaches, and a rejected question is shown as rejected", () => {
    const { view, files } = quest(HERO_TICK, "9a11ed");
    expect(view.headline).toBe("Stopped after 3 attempts. It needs a new lead.");
    expect(view.action).toBeNull();
    expect(view.ladder.map((entry) => entry.strategy)).toEqual([
      "initial", "alternate_hypothesis", "additional_evidence", "additional_evidence",
    ]);
    expect(view.ladder.at(-1)!.exhausted).toBe(true);
    expect(view.question).toMatchObject({ status: "rejected", open: false, delivery: "Not sent yet" });
    expect(parseRecovery(files).length).toBe(files.length);
  });

  test("the rolled-back quest names the regression in production", () => {
    const { view } = quest(HERO_TICK, "d1a905");
    expect(view.detail).toBe("p95 latency on POST /api/* rose from 180 ms to 410 ms");
  });

  test("a working quest says what its agent is doing this second", () => {
    const line = nowLine(timelines().find((timeline) => timeline.script.hex === "7f3a2c")!, HERO_TICK);
    expect(line).toContain("src/billing/round.ts");
  });
});

describe("the hour plays out", () => {
  test("where every quest ends when nobody touches anything", () => {
    const end = Object.fromEntries(worldAt(LAST_TICK).quests.map((entry) => [entry.script.hex, entry.trail.state]));
    expect(end).toEqual({
      "7f3a2c": "closed", b41e07: "watching", c0ffee: "ready", d1a905: "watching", e5cafe: "closed",
      f00d42: "closed", "9a11ed": "parked",
    });
  });

  test("an accepted answer resumes the asking quest as new evidence", () => {
    const before = quest(151, "b41e07");
    const after = quest(153, "b41e07");
    expect(before.trail.state).toBe("parked");
    expect(before.view.question).toMatchObject({ status: "answered", answer: { accepted: true, by: "sam" } });
    expect(after.trail.state).toBe("reproducing");
    expect(after.view.attempt!.max).toBe(4);
  });

  test("the rolled-back quest goes round the loop a second time", () => {
    const { events, trail } = quest(LAST_TICK, "d1a905");
    const journey = journeyOf(events, trail);
    expect(journey.at(-1)!.lap).toBe(2);
    expect(journey.some((step) => step.kind === "retreat" && step.type === "rollback_completed")).toBe(true);
    expect(trail.landing!.receipts.length).toBe(3);
  });

  test("time only moves forward: each tick extends the one before", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: LAST_TICK - 1 }), (tick) => {
      const now = worldAt(tick);
      const next = worldAt(tick + 1);
      for (const entry of now.quests) {
        const later = next.quests.find((other) => other.id === entry.id)!;
        expect(later.events.slice(0, entry.events.length)).toEqual(entry.events);
        expect(later.effects.length).toBeGreaterThanOrEqual(entry.effects.length);
      }
      const total = Object.values(now.fleet.counts).reduce((sum, count) => sum + count, 0);
      expect(total).toBe(now.quests.length);
    }), { numRuns: 60 });
  });

  test("an agent's stream only grows", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: LAST_TICK - 1 }), fc.integer({ min: 0, max: QUESTS.length - 1 }), (tick, index) => {
      const timeline = timelines()[index]!;
      for (const run of timeline.runs) {
        const now = runEventsAt(timeline, run.id, tick);
        const next = runEventsAt(timeline, run.id, tick + 1);
        expect(next.slice(0, now.length)).toEqual(now);
        for (const event of next) expect(AgentRunEvent.safeParse(event).success).toBe(true);
      }
    }), { numRuns: 40 });
  });
});

describe("a person's decision changes the hour", () => {
  const C = id("c0ffee");

  test("approving the landing lands, watches and closes the quest", () => {
    fc.assert(fc.property(fc.integer({ min: 61, max: 170 }), (tick) => {
      const injected: Injected[] = [{ quest: C, tick, action: "approve" }];
      expect(quest(tick - 1, "c0ffee", injected).view.attention).toBe("needs_you");
      expect(quest(tick + 4, "c0ffee", injected).trail.state).toBe("watching");
      const end = quest(LAST_TICK, "c0ffee", injected);
      expect(end.trail.state).toBe("closed");
      expect(end.trail.checkpoints.C).toMatchObject({ by: "human", who: VIEWER, verdict: "approve" });
      expect(end.trail.landing!.receipts[0]!.mode).toBe("tangled_pull");
    }), { numRuns: 12 });
  });

  test("sending it back starts a second approach, then asks again", () => {
    const injected: Injected[] = [{ quest: C, tick: 112, action: "revise", note: "Also refuse a second capture." }];
    const working = quest(116, "c0ffee", injected);
    expect(working.trail.state).toBe("patching");
    expect(working.view.attention).toBe("recovering");
    expect(working.view.ladder.map((entry) => entry.strategy)).toEqual(["initial", "alternate_hypothesis"]);
    expect(working.view.ladder.at(-1)!.observations).toEqual(["Also refuse a second capture."]);
    const again = quest(140, "c0ffee", injected);
    expect(again.view.attention).toBe("needs_you");
    expect(again.trail.rev).toBe(3);
  });

  test("dropping it ends it", () => {
    const end = quest(LAST_TICK, "c0ffee", [{ quest: C, tick: 120, action: "drop" }]);
    expect(end.view.attention).toBe("dropped");
    expect(worldAt(LAST_TICK, [{ quest: C, tick: 120, action: "drop" }]).fleet.groups.you).toBe(0);
  });

  test("no decision, at any moment, on any quest, breaks the world", () => {
    const action = fc.record({
      quest: fc.constantFrom(...QUESTS.map((script) => id(script.hex))),
      tick: fc.integer({ min: 0, max: LAST_TICK }),
      action: fc.constantFrom("approve" as const, "revise" as const, "drop" as const, "resume" as const),
    });
    fc.assert(fc.property(fc.array(action, { maxLength: 4 }), fc.integer({ min: 0, max: LAST_TICK }), (injected, tick) => {
      const world = worldAt(tick, injected);
      expect(world.views.length).toBe(world.quests.length);
      for (const entry of world.quests) {
        expect(Trail.safeParse(entry.trail).success).toBe(true);
        expect(journeyOf(entry.events, entry.trail).length).toBeGreaterThanOrEqual(entry.events.length);
      }
      expect(world.fleet.groups.self + world.fleet.groups.you + world.fleet.groups.stopped + world.fleet.groups.finished)
        .toBe(world.quests.length);
    }), { numRuns: 40 });
  });
});
