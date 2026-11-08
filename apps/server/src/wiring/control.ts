import type { Runner, RunnerHandle } from "@ephyra/core";

export type StopReceipt = {
  handleId: string | null;
  status: "destroyed" | "pending_allocation" | "reconciliation_required" | "not_running";
  at?: string;
};
type Active = {
  trailId: string;
  controller: AbortController;
  handles: Map<string, RunnerHandle>;
  destroying: Map<string, Promise<{ destroyed: true; at: string }>>;
  destroy(handle: RunnerHandle): Promise<{ destroyed: true; at: string }>;
};

/** A kill aborts control-plane work and destroys the actual allocated runner, not just its projection. */
export class WorkControl {
  private active = new Set<Active>();

  async run<T>(trailId: string, runner: Runner, work: (runner: Runner, signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const handles = new Map<string, RunnerHandle>();
    const destroying = new Map<string, Promise<{ destroyed: true; at: string }>>();
    const destroy = (handle: RunnerHandle) => {
      let pending = destroying.get(handle.id);
      if (!pending) {
        pending = runner.destroy(handle);
        destroying.set(handle.id, pending);
      }
      return pending;
    };
    const entry: Active = { trailId, controller, handles, destroying, destroy };
    this.active.add(entry);
    const { signal } = controller;
    const controlled: Runner = {
      name: runner.name,
      capabilities: runner.capabilities,
      allocate: async (request) => {
        signal.throwIfAborted();
        const handle = await runner.allocate(request);
        handles.set(handle.id, handle);
        if (signal.aborted) {
          await destroy(handle);
          signal.throwIfAborted();
        }
        return handle;
      },
      exec: async function* (handle, command, options) {
        signal.throwIfAborted();
        const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
        for await (const part of runner.exec(handle, command, { ...options, signal: combined })) {
          combined.throwIfAborted();
          yield part;
        }
        combined.throwIfAborted();
      },
      readFile: async (handle, path) => { signal.throwIfAborted(); return runner.readFile(handle, path); },
      writeFile: async (handle, path, bytes) => { signal.throwIfAborted(); return runner.writeFile(handle, path, bytes); },
      checkpoint: async (handle) => { signal.throwIfAborted(); return runner.checkpoint(handle); },
      restore: async (snapshot, request) => {
        signal.throwIfAborted();
        const handle = await runner.restore(snapshot, request);
        handles.set(handle.id, handle);
        if (signal.aborted) { await destroy(handle); signal.throwIfAborted(); }
        return handle;
      },
      exportArtifacts: async (handle, paths) => { signal.throwIfAborted(); return runner.exportArtifacts(handle, paths); },
      destroy,
    };
    try {
      return await work(controlled, signal);
    } finally {
      this.active.delete(entry);
    }
  }

  async stop(trailId: string): Promise<StopReceipt[]> {
    const entries = [...this.active].filter((entry) => entry.trailId === trailId);
    // Abort all executors before waiting on any provider's teardown.
    for (const entry of entries) entry.controller.abort(new Error("Trail execution was stopped"));
    if (!entries.length) return [{ handleId: null, status: "not_running" }];
    const receipts: StopReceipt[] = [];
    for (const entry of entries) {
      if (!entry.handles.size) receipts.push({ handleId: null, status: "pending_allocation" });
      for (const handle of entry.handles.values()) {
        try {
          const receipt = await entry.destroy(handle);
          receipts.push({ handleId: handle.id, status: "destroyed", at: receipt.at });
        } catch {
          receipts.push({ handleId: handle.id, status: "reconciliation_required" });
        }
      }
    }
    return receipts;
  }

  async stopAll(): Promise<StopReceipt[]> {
    const reports = await Promise.all([...new Set([...this.active].map((entry) => entry.trailId))].map((id) => this.stop(id)));
    return reports.flat();
  }
}
