import type { SetupMode, SetupRun } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome } from "../api.ts";
import type { SetupApi } from "../setup-api.ts";

export type SetupState = {
  run: SetupRun | null;
  busy: boolean;
  loaded: boolean;
  uncertain: boolean;
  error?: string;
};
export type SetupPending = { key: string; previousRun: string | null };
export interface PendingSetupStore {
  read(): SetupPending | null;
  write(value: SetupPending | null): void;
}

const memoryPending = new Map<string, SetupPending>();

/** Only a credential-free operation reference survives reload. It never grants access. */
export function browserSetupStore(account: string, workspace: string): PendingSetupStore {
  const key = `ephyra.setup.pending:${account}:${workspace}`;
  return {
    read() {
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");
        return value && typeof value.key === "string" &&
          (value.previousRun === null || typeof value.previousRun === "string") ? value : (memoryPending.get(key) ?? null);
      } catch { return memoryPending.get(key) ?? null; }
    },
    write(value) {
      if (value) memoryPending.set(key, value);
      else memoryPending.delete(key);
      try {
        if (value) localStorage.setItem(key, JSON.stringify(value));
        else localStorage.removeItem(key);
      } catch { /* The running tab still keeps the pending reference. */ }
    },
  };
}

/** Serializes starts and refreshes; a lost write is followed only by reads. */
export class SetupController {
  private state: SetupState = { run: null, busy: false, loaded: false, uncertain: false };
  private listeners = new Set<() => void>();
  private loading?: Promise<void>;
  constructor(private readonly api: SetupApi, private readonly pending: PendingSetupStore) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(value: Partial<SetupState>) {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  async load(mode: SetupMode) {
    if (this.loading) return this.loading;
    this.loading = this.initialize(mode).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  private async initialize(mode: SetupMode) {
    await this.refresh();
    if (this.state.loaded && !this.state.run && !this.state.error && !this.state.uncertain) await this.start(mode);
  }
  async refresh() {
    if (this.state.busy) return;
    this.set({ busy: true, error: undefined });
    try {
      const pending = this.pending.read();
      const run = await this.api.current(undefined, pending?.key);
      // Only the exact receipt proves this start was recorded; another tab's run does not.
      const unresolved = Boolean(pending && run?.operationKey !== pending.key);
      if (pending && !unresolved) this.pending.write(null);
      this.set({ run: unresolved ? this.state.run : run, loaded: true, uncertain: unresolved });
    } catch (error) {
      this.set({ error: message(error), uncertain: this.pending.read() !== null });
    } finally { this.set({ busy: false }); }
  }
  async start(mode: SetupMode) {
    if (this.state.busy || this.state.uncertain || this.pending.read()) return;
    const key = `setup:${crypto.randomUUID()}`;
    this.pending.write({ key, previousRun: this.state.run?.id ?? null });
    this.set({ busy: true, error: undefined });
    try {
      const run = await this.api.start({ mode }, key);
      this.pending.write(null);
      this.set({ run, loaded: true, uncertain: false });
    } catch (error) {
      const uncertain = error instanceof UnknownWriteOutcome;
      if (!uncertain) this.pending.write(null);
      this.set({ uncertain, error: uncertain ? undefined : message(error) });
    } finally { this.set({ busy: false }); }
  }
}

function message(error: unknown) {
  if (error instanceof ApiError) return error.detail ?? error.message;
  return error instanceof Error ? error.message : "Setup is unavailable. Refresh to check its progress.";
}
