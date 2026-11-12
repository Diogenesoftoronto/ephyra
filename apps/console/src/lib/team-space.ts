import type { ActivityItem, InvestigationQuestion, PeopleConnection, Trail } from "@ephyra/core";
import type { InboxEntry } from "../api.ts";

/**
 * The team view as one pure projection: what Ephyra is asking people for, who each ask waits on, and what the
 * work looks like by status. Inputs are only the fields read, so callers and tests can pass partial records.
 */
export type SpaceQuestion = Pick<InvestigationQuestion,
  "id" | "trailId" | "status" | "question" | "reason" | "recipient" | "delivery" | "createdAt">;
export type SpaceInbox = Pick<InboxEntry,
  "trailId" | "short" | "title" | "kind" | "checkpoint" | "blocking" | "artefact" | "createdAt" | "risk"> &
  Partial<Pick<InboxEntry, "shadowVerdict">>;
export type SpaceTrail = Pick<Trail, "id" | "short" | "title" | "state" | "area" | "owner" | "updatedAt"> & {
  landing?: { receipts: readonly unknown[] };
};

/** Whom an ask is waiting on. A contact without a DID is named only by the owner's alias. */
export type WaitingOn =
  | { kind: "person"; did: string; alias?: string }
  | { kind: "contact"; id: string; alias: string }
  | { kind: "approvers" }
  | { kind: "nobody" };

export type Delivery = "inbox" | "bridge" | "unconfirmed" | "not_sent";

export interface Ask {
  key: string;
  kind: "question" | "checkpoint" | "spend" | "parked";
  trailId: string;
  short: string | null;
  title: string;
  detail: string;
  waitingOn: WaitingOn;
  blocking: boolean;
  since: string;
  checkpoint?: "A" | "B" | "C";
  delivery?: Delivery;
  shadowVerdict?: "approve" | "revise" | "reject";
}

export type WorkGroupId = "investigating" | "fixing" | "landing" | "watching" | "paused";
export interface WorkGroup { id: WorkGroupId; label: string; trails: SpaceTrail[] }

const GROUP: Record<Trail["state"], WorkGroupId | "ended"> = {
  sensed: "investigating", triaged: "investigating", researching: "investigating", hypothesised: "investigating",
  reproducing: "fixing", planned: "fixing", patching: "fixing", proving: "fixing",
  ready: "landing", landing: "landing",
  watching: "watching",
  parked: "paused", handed_off: "paused", rolled_back: "paused",
  closed: "ended", abandoned: "ended",
};
export const WORK_GROUPS: readonly { id: WorkGroupId; label: string }[] = [
  { id: "investigating", label: "Investigating" },
  { id: "fixing", label: "Fixing" },
  { id: "landing", label: "Ready to land" },
  { id: "watching", label: "Watching" },
  { id: "paused", label: "Paused" },
];

/** An investigation question still open with a person. `checking` has not been sent; settled ones are done. */
const OPEN_QUESTION: ReadonlySet<InvestigationQuestion["status"]> = new Set(["awaiting_answer", "ambiguous"]);

export function delivery(q: Pick<InvestigationQuestion, "status" | "delivery">): Delivery {
  if (q.status === "ambiguous" || q.delivery.status === "uncertain") return "unconfirmed";
  if (q.delivery.status === "not_sent") return "not_sent";
  return q.delivery.kind === "inbox" ? "inbox" : "bridge";
}

export function asks(input: { inbox: readonly SpaceInbox[]; questions: readonly SpaceQuestion[]; trails: readonly SpaceTrail[] }): Ask[] {
  const trail = new Map(input.trails.map((t) => [t.id, t]));
  const out: Ask[] = [];
  for (const q of input.questions) {
    if (!OPEN_QUESTION.has(q.status)) continue;
    const r = q.recipient;
    out.push({
      key: `question:${q.id}`, kind: "question", trailId: q.trailId, short: trail.get(q.trailId)?.short ?? null,
      title: q.question, detail: q.reason, blocking: true, since: q.createdAt, delivery: delivery(q),
      waitingOn: !r ? { kind: "nobody" } : r.did ? { kind: "person", did: r.did, alias: r.alias } : { kind: "contact", id: r.id, alias: r.alias },
    });
  }
  for (const e of input.inbox) {
    if (e.kind === "notice") continue;
    const owner = trail.get(e.trailId)?.owner;
    out.push({
      key: `${e.kind}:${e.trailId}:${e.checkpoint ?? ""}`, kind: e.kind, trailId: e.trailId, short: e.short,
      title: e.title, detail: e.artefact.summary, blocking: e.blocking, since: e.createdAt,
      ...(e.checkpoint ? { checkpoint: e.checkpoint } : {}),
      ...(e.shadowVerdict ? { shadowVerdict: e.shadowVerdict } : {}),
      waitingOn: owner?.kind === "human" ? { kind: "person", did: owner.id } : { kind: "approvers" },
    });
  }
  // Blocking asks first, then the longest wait, so the oldest stall is never below fresher noise.
  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking) || Date.parse(a.since) - Date.parse(b.since) || a.key.localeCompare(b.key));
}

export function waitingKey(w: WaitingOn): string {
  return w.kind === "person" ? `person:${w.did}` : w.kind === "contact" ? `contact:${w.id}` : w.kind;
}

/** Who is holding things up, most asks first. */
export function blockers(list: readonly Ask[]): { waitingOn: WaitingOn; count: number; blocking: number }[] {
  const by = new Map<string, { waitingOn: WaitingOn; count: number; blocking: number }>();
  for (const a of list) {
    const k = waitingKey(a.waitingOn);
    const row = by.get(k) ?? { waitingOn: a.waitingOn, count: 0, blocking: 0 };
    row.count += 1;
    if (a.blocking) row.blocking += 1;
    by.set(k, row);
  }
  return [...by.values()].sort((a, b) => b.blocking - a.blocking || b.count - a.count || waitingKey(a.waitingOn).localeCompare(waitingKey(b.waitingOn)));
}

export function workGroups(trails: readonly SpaceTrail[]): WorkGroup[] {
  return WORK_GROUPS.map((g) => ({
    ...g,
    trails: trails.filter((t) => GROUP[t.state] === g.id)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)),
  }));
}

const DAY = 86_400_000;
/**
 * The last `days` days, Spaces-style: landed means closed with a recorded landing receipt; a quest closed without
 * one, or abandoned, ended. Open counts every quest not yet ended, however old.
 */
export function recentCounts(trails: readonly SpaceTrail[], now: number, days = 30): { landed: number; ended: number; open: number } {
  const since = now - days * DAY;
  let landed = 0, ended = 0, open = 0;
  for (const t of trails) {
    if (GROUP[t.state] !== "ended") { open += 1; continue; }
    if (Date.parse(t.updatedAt) < since) continue;
    if (t.state === "closed" && (t.landing?.receipts.length ?? 0) > 0) landed += 1; else ended += 1;
  }
  return { landed, ended, open };
}

/** Per-person load: asks waiting on them by DID, and open quests they own. */
export function load(list: readonly Ask[], trails: readonly SpaceTrail[]): Map<string, { waiting: number; owns: number }> {
  const out = new Map<string, { waiting: number; owns: number }>();
  const row = (did: string) => { const r = out.get(did) ?? { waiting: 0, owns: 0 }; out.set(did, r); return r; };
  for (const a of list) if (a.waitingOn.kind === "person") row(a.waitingOn.did).waiting += 1;
  for (const t of trails) if (t.owner?.kind === "human" && GROUP[t.state] !== "ended") row(t.owner.id).owns += 1;
  return out;
}

export interface ChannelStatus {
  bridge: "connected" | "incomplete" | "off" | "unknown";
  host: string | null;
  contacts: number;
}
/** What the delivery bridge can actually do, from saved settings. It never claims a message reached anyone. */
export function channelStatus(people: PeopleConnection | null | undefined, ownerDid?: string): ChannelStatus {
  if (people === undefined) return { bridge: "unknown", host: null, contacts: 0 };
  if (!people) return { bridge: "off", host: null, contacts: 0 };
  let host: string | null = null;
  try { host = people.webhookUrl ? new URL(people.webhookUrl).host : null; } catch { host = null; }
  const contacts = people.contacts.filter((c) => !c.did || c.did !== ownerDid).length;
  if (!people.enabled) return { bridge: "off", host, contacts };
  return { bridge: host && people.keyConfigured ? "connected" : "incomplete", host, contacts };
}

/** Agent work happening right now, newest first. */
export function running(items: readonly ActivityItem[]): ActivityItem[] {
  return items.filter((i) => i.status === "running")
    .sort((a, b) => Date.parse(b.startedAt ?? b.at) - Date.parse(a.startedAt ?? a.at) || a.id.localeCompare(b.id));
}
