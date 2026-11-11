// The live board: what the console polls from a real server, turned into the same view-models the lab draws.
// Everything here is pure. `app/useLoop.ts` does the fetching and hands its results to these functions.
import type { AgentRun, AgentRunEvent, Effect, InvestigationQuestion, Trail, TrailEvent, TrailState } from "@ephyra/core";
import { fleetView, lastOf, parseRecovery, questView, type FleetView, type InboxLike, type QuestView } from "./model.ts";

export type LiveDetail = {
  trail: Trail;
  events: TrailEvent[];
  artefacts?: { path: string; content: string | null }[];
  effects?: { cause: string; effect: Effect }[];
};

export type LiveQuest = {
  id: string;
  trail: Trail;
  events: readonly TrailEvent[];
  /** Null when the server keeps no effect history for this quest, which is different from "asked for nothing". */
  effects: readonly { cause: string; effect: Effect }[] | null;
  view: QuestView;
  /** False until the quest's journal has been read once: its view then rests on the list entry alone. */
  loaded: boolean;
};

export type LiveBoard = { quests: LiveQuest[]; views: QuestView[]; fleet: FleetView };

type AssembleInput = {
  trails: readonly Trail[];
  details: ReadonlyMap<string, LiveDetail>;
  inbox: readonly InboxLike[];
  questions: readonly InvestigationQuestion[];
  runs?: readonly AgentRun[];
  viewer?: string;
};

/**
 * One view per quest, so a quest drawn twice agrees with itself. The journal's copy of a trail wins unless the list has
 * moved past it, which means the detail on hand is from before the last change and is about to be read again.
 */
export function assemble(input: AssembleInput): LiveBoard {
  const quests = input.trails.map((listed): LiveQuest => {
    const detail = input.details.get(listed.id) ?? null;
    const current = detail !== null && detail.trail.updatedAt >= listed.updatedAt;
    const trail = current ? detail.trail : listed;
    const events = detail?.events ?? [];
    const view = questView({
      trail, events, inbox: input.inbox, questions: input.questions, viewer: input.viewer,
      recovery: parseRecovery(detail?.artefacts ?? []), runs: input.runs,
    });
    return { id: listed.id, trail, events, effects: detail?.effects ?? null, view, loaded: detail !== null };
  });
  const views = quests.map((quest) => quest.view);
  return { quests, views, fleet: fleetView(views) };
}

const WORKING = new Set<TrailState>(["researching", "reproducing", "patching", "proving"]);

type PlanInput = {
  trails: readonly Trail[];
  /** `updatedAt` of the detail already on hand, by quest id. */
  known: ReadonlyMap<string, string>;
  selected: string | null;
  /** Where the round of working quests stopped last time. */
  cursor: number;
  /** Most journals read in one poll. */
  budget?: number;
};

/**
 * Which journals to read this poll: the selected quest, every quest whose list entry changed, then working quests in
 * turn. A working quest is read even when its list entry is unchanged, because the plan for its current attempt is
 * journaled without an event and so does not move `updatedAt`.
 */
export function detailPlan({ trails, known, selected, cursor, budget = 8 }: PlanInput): { ids: string[]; cursor: number } {
  const ids: string[] = [];
  const add = (id: string) => { if (ids.length < budget && !ids.includes(id)) ids.push(id); };
  if (selected && trails.some((trail) => trail.id === selected)) add(selected);
  for (const trail of trails) if (known.get(trail.id) !== trail.updatedAt) add(trail.id);
  const working = trails.filter((trail) => WORKING.has(trail.state) && !ids.includes(trail.id));
  // Always make room for one working quest, so a burst of changes cannot starve the round.
  const room = Math.max(working.length ? 1 : 0, budget - ids.length);
  let next = cursor;
  for (let i = 0; i < Math.min(room, working.length); i++) {
    ids.push(working[(cursor + i) % working.length]!.id);
    next = cursor + i + 1;
  }
  return { ids, cursor: working.length ? next % working.length : 0 };
}

/** What the running agent is doing right now, as one line: its last tool call, or the last thing it said. */
export function runNow(events: readonly AgentRunEvent[]): string | null {
  const last = lastOf(events, (event) => event.type === "tool_call" || event.type === "message" || event.type === "status");
  if (!last) return null;
  const text = last.tool ? `${last.tool.name} ${last.tool.args ?? ""}` : last.text ?? "";
  const line = text.replace(/\s+/g, " ").trim();
  return line ? (line.length > 96 ? `${line.slice(0, 95)}…` : line) : null;
}

/** New run events appended to the ones on hand, in order, with nothing repeated. */
export function mergeRunEvents(have: readonly AgentRunEvent[], more: readonly AgentRunEvent[]): AgentRunEvent[] {
  const last = have.at(-1)?.seq ?? -1;
  return [...have, ...more.filter((event) => event.seq > last).sort((a, b) => a.seq - b.seq)];
}
