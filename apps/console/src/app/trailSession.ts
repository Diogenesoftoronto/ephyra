import { useSyncExternalStore } from "react";
import { UnknownWriteOutcome, type ConsoleApi } from "../api.ts";
import { newOp } from "../lib/hooks.ts";

type SharedAction = "comment" | "claim" | "release";
type Pending = {
  action: SharedAction;
  input: { text?: string; reason?: string };
  key: string;
  phase: "sending" | "unknown" | "not_found";
};
type Snapshot = { draft: string; pending?: Pending };

/** In-memory, account/API-scoped state. A route change must not invent a new operation after an ambiguous write. */
export class TrailSession {
  private snapshot: Snapshot = { draft: "" };
  private listeners = new Set<() => void>();
  constructor(private api: ConsoleApi, private trailId: string) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(snapshot: Snapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  setDraft = (draft: string) => this.set({ ...this.snapshot, draft });
  private confirmed(pending: Pending) {
    // A newer draft typed while the request was in flight belongs to the next comment.
    const clear = pending.action === "comment" && this.snapshot.draft.trim() === pending.input.text;
    this.set({ draft: clear ? "" : this.snapshot.draft });
  }
  private async perform(pending: Pending) {
    this.set({ ...this.snapshot, pending: { ...pending, phase: "sending" } });
    try {
      await this.api.trailAction(this.trailId, pending.action, pending.input, pending.key);
      this.confirmed(pending);
    } catch (error) {
      if (error instanceof UnknownWriteOutcome) {
        this.set({ ...this.snapshot, pending: { ...pending, phase: "unknown" } });
      } else {
        this.set({ draft: this.snapshot.draft });
      }
      throw error;
    }
  }
  act = async (action: SharedAction, input: Pending["input"]) => {
    if (this.snapshot.pending) throw new Error("Check the pending change before starting another.");
    await this.perform({ action, input: { ...input }, key: newOp(), phase: "sending" });
  };
  reconcile = async () => {
    const pending = this.snapshot.pending;
    if (!pending || pending.phase === "sending") return;
    const receipt = await this.api.trailOperation(this.trailId, pending.action, pending.key);
    if (this.snapshot.pending?.key !== pending.key) return;
    if (receipt.status === "recorded") this.confirmed(pending);
    else this.set({ ...this.snapshot, pending: { ...pending, phase: "not_found" } });
  };
  retry = async () => {
    const pending = this.snapshot.pending;
    if (!pending || pending.phase !== "not_found") throw new Error("Check delivery before retrying this change.");
    // Explicit retry of the saved intent after a receipt lookup, with the very same durable operation key.
    await this.perform(pending);
  };
}

const sessions = new WeakMap<ConsoleApi, Map<string, TrailSession>>();
export function getTrailSession(api: ConsoleApi, principal: string | undefined, trailId: string): TrailSession {
  let account = sessions.get(api);
  if (!account) { account = new Map(); sessions.set(api, account); }
  const key = JSON.stringify([principal ?? null, trailId]);
  let session = account.get(key);
  if (!session) { session = new TrailSession(api, trailId); account.set(key, session); }
  return session;
}

export function useTrailSession(api: ConsoleApi, principal: string | undefined, trailId: string) {
  const session = getTrailSession(api, principal, trailId);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { ...snapshot, session };
}
