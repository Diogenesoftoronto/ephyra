import { useEffect, useSyncExternalStore } from "react";
import type { Draft, PolicyActivationReceipt } from "@ephyra/core";
import { ApiError, ConsoleClient, UnknownWriteOutcome, type ActivatePolicyInput, type ConsoleApi } from "../api.ts";
import { newOp } from "../lib/hooks.ts";

type PendingActivation = ActivatePolicyInput & { key: string; path: string };
export type ActivationSnapshot = {
  status: "idle" | "loading" | "ready" | "unavailable";
  active: PolicyActivationReceipt | null;
  busy: boolean;
  current: boolean;
  pending?: PendingActivation;
  error?: unknown;
};
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStorage = (): StoragePort | undefined => { try { return globalThis.sessionStorage; } catch { return undefined; } };
export type PolicyActivationControls = ActivationSnapshot & { activate(): Promise<void>; reload(): Promise<void> };

export async function policyContentDigest(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A pending policy mutation survives navigation and is never automatically submitted a second time. */
export class PolicyActivationSession {
  private snapshot: ActivationSnapshot = { status: "idle", active: null, busy: false, current: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private storageKey: string;
  constructor(private readonly api: ConsoleApi, private readonly draftId: string, scope: string,
    private readonly storage: StoragePort | undefined = browserStorage()) {
    this.storageKey = `ephyra.policy-activation:${JSON.stringify([scope, draftId])}`;
    try {
      const pending = JSON.parse(this.storage?.getItem(this.storageKey) ?? "null") as PendingActivation | null;
      if (pending && /^[A-Za-z0-9._:-]{8,100}$/.test(pending.key) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(pending.expectedCommit)
        && /^[a-f0-9]{64}$/.test(pending.expectedDigest) && typeof pending.path === "string"
        && (pending.expectedActive === null || /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(pending.expectedActive)))
        this.snapshot = { ...this.snapshot, pending };
    } catch { /* Unavailable local storage cannot authorize a mutation. */ }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(snapshot: ActivationSnapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener(); }
  private remember(pending?: PendingActivation) {
    try {
      if (pending) this.storage?.setItem(this.storageKey, JSON.stringify(pending));
      else this.storage?.removeItem(this.storageKey);
    } catch { /* The mounted/API-scoped session still retains its pending operation. */ }
  }
  private matches(active: PolicyActivationReceipt | null, path: string, digest: string): boolean {
    return active?.documents.some((document) => document.path === path && document.digest === digest) ?? false;
  }

  async load(draft: Draft): Promise<void> {
    if (this.snapshot.busy || draft.status !== "published") return;
    const generation = ++this.generation;
    if (!this.api.activePolicy || !this.api.activatePolicy) {
      this.set({ ...this.snapshot, status: "unavailable" }); return;
    }
    this.set({ ...this.snapshot, status: "loading", error: undefined });
    try {
      const [active, digest] = await Promise.all([this.api.activePolicy(), policyContentDigest(draft.content)]);
      if (generation !== this.generation) return;
      let pending = this.snapshot.pending;
      if (pending && this.matches(active, pending.path, pending.expectedDigest)) {
        pending = undefined; this.remember();
      }
      this.set({ status: "ready", active, pending, busy: false, current: this.matches(active, draft.path, digest) });
    } catch (error) {
      if (generation !== this.generation) return;
      const unavailable = error instanceof ApiError && [404, 405, 501].includes(error.status);
      this.set({ ...this.snapshot, status: unavailable ? "unavailable" : "ready", error });
    }
  }

  async activate(draft: Draft): Promise<void> {
    if (draft.id !== this.draftId || draft.status !== "published" || !draft.published || !this.api.activatePolicy
      || this.snapshot.status !== "ready" || this.snapshot.busy || this.snapshot.current || this.snapshot.pending || this.snapshot.error)
      throw new Error("Review the current policy state before activating this draft.");
    this.set({ ...this.snapshot, busy: true, error: undefined });
    let expectedDigest: string;
    try { expectedDigest = await policyContentDigest(draft.content); }
    catch (error) { this.set({ ...this.snapshot, busy: false, error }); throw error; }
    const pending: PendingActivation = { key: newOp(), path: draft.path, expectedCommit: draft.published.commit,
      expectedDigest, expectedActive: this.snapshot.active?.commit ?? null };
    this.remember(pending);
    this.set({ ...this.snapshot, busy: true, pending });
    try {
      const { key, path: _path, ...input } = pending;
      const receipt = await this.api.activatePolicy(draft.id, input, key);
      if (receipt.draftId !== draft.id || receipt.path !== draft.path || receipt.sourceCommit !== pending.expectedCommit
        || receipt.sourceDigest !== pending.expectedDigest || receipt.previousActive !== pending.expectedActive
        || !this.matches(receipt, draft.path, pending.expectedDigest))
        throw new UnknownWriteOutcome(key);
      this.remember();
      this.set({ status: "ready", active: receipt, busy: false, current: true });
    } catch (error) {
      const unknown = error instanceof UnknownWriteOutcome;
      if (!unknown) this.remember();
      this.set({ ...this.snapshot, busy: false, error, pending: unknown ? pending : undefined });
      throw error;
    }
  }
}

const sessions = new WeakMap<ConsoleApi, Map<string, PolicyActivationSession>>();
function sessionFor(api: ConsoleApi, id: string): PolicyActivationSession {
  let group = sessions.get(api);
  if (!group) { group = new Map(); sessions.set(api, group); }
  let session = group.get(id);
  if (!session) {
    const scope = api instanceof ConsoleClient ? JSON.stringify([api.baseUrl, api.principal ?? null, api.workspaceId ?? null]) : "fixture";
    session = new PolicyActivationSession(api, id, scope);
    group.set(id, session);
  }
  return session;
}

export function usePolicyActivationSession(api: ConsoleApi, draft: Draft | null) {
  const session = sessionFor(api, draft?.id ?? "unloaded");
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => { if (draft?.status === "published") void session.load(draft); }, [session, draft?.id, draft?.status]);
  return { ...state, activate: () => draft ? session.activate(draft) : Promise.resolve(),
    reload: () => draft ? session.load(draft) : Promise.resolve() };
}
