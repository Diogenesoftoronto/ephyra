import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { AgentRunEvent, Trail, TrailState } from "@ephyra/core";
import { sceneViews } from "./board.tsx";
import { assemble, detailPlan, mergeRunEvents, runNow, type LiveDetail } from "./live.ts";
import { fleetView } from "./model.ts";
import { LAST_TICK, VIEWER, worldAt } from "./scenario.ts";

// The simulated hour supplies quests in every state the real server produces, as the shapes the server returns them in.
const tick = fc.integer({ min: 0, max: LAST_TICK });
const served = (at: number) => {
  const world = worldAt(at);
  const details = new Map<string, LiveDetail>(world.quests.map((quest) => [quest.id, {
    trail: quest.trail, events: quest.events, artefacts: quest.files,
    effects: quest.effects.map(({ cause, effect }) => ({ cause, effect })),
  }]));
  return {
    world, details, trails: world.quests.map((quest) => quest.trail),
    inbox: world.quests.flatMap((quest) => quest.inbox), questions: world.quests.flatMap((quest) => quest.questions),
    runs: world.quests.flatMap((quest) => quest.runs),
  };
};

describe("the live board", () => {
  test("with every journal read, the board says exactly what the same data says anywhere else", () => {
    fc.assert(fc.property(tick, (at) => {
      const { world, ...input } = served(at);
      const board = assemble({ ...input, viewer: VIEWER });
      expect(board.quests.map((quest) => quest.id)).toEqual(world.quests.map((quest) => quest.id));
      for (const quest of board.quests) {
        const told = world.views.find((view) => view.id === quest.id)!;
        expect([quest.view.stage.id, quest.view.attention, quest.view.retreats]).toEqual([told.stage.id, told.attention, told.retreats]);
        expect(quest.loaded).toBe(true);
      }
      expect(board.fleet.sentence).toBe(fleetView(board.views).sentence);
    }), { numRuns: 60 });
  });

  test("a journal read before the last change never overrides the newer list entry", () => {
    fc.assert(fc.property(tick, tick, (earlier, later) => {
      fc.pre(earlier < later);
      const old = served(earlier);
      const now = served(later);
      const board = assemble({ ...now, details: old.details, viewer: VIEWER });
      for (const quest of board.quests) {
        const listed = now.trails.find((trail) => trail.id === quest.id)!;
        const detail = old.details.get(quest.id);
        // Whichever copy is newer decides the state, so a quest never appears to go backwards while its journal is re-read.
        const expected = detail && detail.trail.updatedAt >= listed.updatedAt ? detail.trail.state : listed.state;
        expect(quest.trail.state).toBe(expected);
        expect(quest.loaded).toBe(detail !== undefined);
      }
    }), { numRuns: 60 });
  });

  test("a quest whose journal has not been read is still drawn, from its list entry, and says it has no effects on record", () => {
    const { world, ...input } = served(LAST_TICK);
    const board = assemble({ ...input, details: new Map(), viewer: VIEWER });
    expect(board.quests).toHaveLength(world.quests.length);
    expect(board.quests.every((quest) => !quest.loaded && quest.effects === null && quest.events.length === 0)).toBe(true);
  });
});

const STATES: TrailState[] = ["researching", "reproducing", "patching", "proving", "ready", "watching", "parked", "closed"];
const listing = fc.array(fc.record({ state: fc.constantFrom(...STATES), updatedAt: fc.integer({ min: 0, max: 9 }), known: fc.boolean() }),
  { maxLength: 30 }).map((rows) => rows.map((row, i) => ({ ...row, id: `quest-${i}` })));
const asTrails = (rows: { id: string; state: TrailState; updatedAt: number }[]) =>
  rows.map((row) => ({ id: row.id, state: row.state, updatedAt: String(row.updatedAt) }) as Trail);
const WORKING = new Set<TrailState>(["researching", "reproducing", "patching", "proving"]);

describe("which journals a poll reads", () => {
  test("never more than its budget plus one, never the same one twice, and only quests that exist", () => {
    fc.assert(fc.property(listing, fc.integer({ min: 1, max: 8 }), fc.nat(40), fc.option(fc.nat(35)), (rows, budget, cursor, pick) => {
      const known = new Map(rows.filter((row) => row.known).map((row) => [row.id, String(row.updatedAt)]));
      const selected = pick === null ? null : `quest-${pick}`;
      const plan = detailPlan({ trails: asTrails(rows), known, selected, cursor, budget });
      expect(plan.ids.length).toBeLessThanOrEqual(budget + 1);
      expect(new Set(plan.ids).size).toBe(plan.ids.length);
      expect(plan.ids.every((id) => rows.some((row) => row.id === id))).toBe(true);
      if (selected && rows.some((row) => row.id === selected)) expect(plan.ids[0]).toBe(selected);
    }), { numRuns: 200 });
  });

  test("a quest whose list entry changed is read on that poll when there is room", () => {
    fc.assert(fc.property(listing, (rows) => {
      const known = new Map(rows.filter((row) => row.known).map((row) => [row.id, String(row.updatedAt)]));
      const changed = rows.filter((row) => !row.known).map((row) => row.id);
      const plan = detailPlan({ trails: asTrails(rows), known, selected: null, cursor: 0, budget: 40 });
      for (const id of changed) expect(plan.ids).toContain(id);
    }), { numRuns: 100 });
  });

  test("every working quest is read within one round, even when nothing in the list changes", () => {
    fc.assert(fc.property(listing, fc.integer({ min: 1, max: 8 }), (rows, budget) => {
      const trails = asTrails(rows);
      const known = new Map(rows.map((row) => [row.id, String(row.updatedAt)]));
      const working = rows.filter((row) => WORKING.has(row.state)).map((row) => row.id);
      const read = new Set<string>();
      let cursor = 0;
      // A plan journaled without an event does not move `updatedAt`, so working quests are read in turn regardless.
      for (let poll = 0; poll < Math.max(1, working.length); poll++) {
        const plan = detailPlan({ trails, known, selected: null, cursor, budget });
        plan.ids.forEach((id) => read.add(id));
        cursor = plan.cursor;
      }
      for (const id of working) expect(read.has(id)).toBe(true);
    }), { numRuns: 200 });
  });
});

describe("run transcripts", () => {
  const event = (seq: number, patch: Partial<AgentRunEvent> = {}): AgentRunEvent =>
    ({ runId: "run", seq, at: "2026-11-10T10:00:00.000Z", type: "message", text: `line ${seq}`, ...patch });

  test("merging keeps order and never repeats a line, whatever overlap the server sends", () => {
    fc.assert(fc.property(fc.nat(30), fc.nat(30), fc.nat(30), (have, from, more) => {
      const start = Math.min(have, from);
      const merged = mergeRunEvents(Array.from({ length: have }, (_, i) => event(i)), Array.from({ length: more }, (_, i) => event(start + i)));
      expect(merged.map((line) => line.seq)).toEqual(Array.from({ length: Math.max(have, start + more) }, (_, i) => i));
    }), { numRuns: 200 });
  });

  test("the now line is the agent's last tool call or message, on one line, cut to fit", () => {
    expect(runNow([])).toBeNull();
    expect(runNow([event(0), event(1, { type: "tool_call", text: undefined, tool: { callId: "c", name: "bun", args: "test\n  cart.test.js" } })]))
      .toBe("bun test cart.test.js");
    expect(runNow([event(0, { text: "x".repeat(300) })])!.length).toBe(96);
    expect(runNow([event(0, { type: "reasoning", text: "private" })])).toBeNull();
  });
});

describe("the scene", () => {
  test("draws every quest in flight and only the most recently finished few", () => {
    fc.assert(fc.property(tick, fc.integer({ min: 0, max: 4 }), (at, keep) => {
      const views = worldAt(at).views;
      const drawn = sceneViews(views, keep);
      const moving = views.filter((view) => view.group !== "finished");
      const finished = views.filter((view) => view.group === "finished");
      expect(drawn.filter((view) => view.group !== "finished")).toEqual(moving);
      const kept = drawn.filter((view) => view.group === "finished");
      expect(kept.length).toBe(Math.min(keep, finished.length));
      const cut = [...finished].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[keep - 1]?.updatedAt;
      if (cut) expect(kept.every((view) => view.updatedAt >= cut)).toBe(true);
    }), { numRuns: 60 });
  });
});
