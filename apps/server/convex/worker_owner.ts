import type { MutationCtx } from "./_generated/server";

export type WorkerOwner = { ownerId?: string; fence?: number };
export const MIN_WORKER_LEASE_MS = 5_000;
export const MAX_WORKER_LEASE_MS = 120_000;

export function leaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_WORKER_LEASE_MS || value > MAX_WORKER_LEASE_MS)
    throw new Error("Worker lease duration is outside its supported bounds");
  return value;
}
export function workerIdentity(value: string): string {
  if (!/^[a-zA-Z0-9._:-]{8,200}$/.test(value)) throw new Error("Invalid worker owner identity");
  return value;
}
export async function currentWorker(ctx: Pick<MutationCtx, "db">, workspace: string | undefined) {
  return ctx.db.query("runtimeWorkers").withIndex("by_workspace", (q) => q.eq("workspace", workspace)).unique();
}
export async function ownsWorker(ctx: Pick<MutationCtx, "db">, workspace: string | undefined, owner: WorkerOwner) {
  if (!owner.ownerId || !Number.isSafeInteger(owner.fence)) return false;
  const current = await currentWorker(ctx, workspace);
  return Boolean(current && current.ownerId === owner.ownerId && current.fence === owner.fence && current.expiresMs > Date.now());
}
export async function requireWorker(ctx: Pick<MutationCtx, "db">, workspace: string | undefined, owner: WorkerOwner) {
  if (!await ownsWorker(ctx, workspace, owner)) throw new Error("Worker lease is not active; reconcile ownership before continuing");
}
