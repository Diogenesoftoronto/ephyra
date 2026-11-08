import { expect, test } from "bun:test";
import { RuntimeWorkerLease, WorkerOwnershipLost, type WorkerLeaseBackend, type WorkerLeaseReceipt } from "./worker-lease.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const receipt = (fence = 1): WorkerLeaseReceipt => ({ active: true, fence, expiresMs: 30000, serverNowMs: 0 });
function fixture(overrides: Partial<WorkerLeaseBackend> = {}) {
  let fence = 0, clock = 0;
  const calls = { register: 0, heartbeat: 0, release: 0, acquired: 0, lost: 0 };
  const backend: WorkerLeaseBackend = {
    register: async () => { calls.register++; return receipt(++fence); },
    heartbeat: async () => { calls.heartbeat++; return receipt(fence); },
    release: async () => { calls.release++; },
    ...overrides,
  };
  const lease = new RuntimeWorkerLease(backend, { ownerId: "worker-fixture", now: () => clock, schedule: false, requestTimeoutMs: 25 });
  const callbacks = { onAcquired: async () => { calls.acquired++; }, onLost: async () => { calls.lost++; } };
  return { lease, calls, callbacks, backend, time: (now: number) => { clock = now; } };
}

test("heartbeat refusal stops local work before a fresh fence may start work", async () => {
  const cleanup = deferred<void>(), lost = deferred<void>();
  const f = fixture();
  expect(await f.lease.start({ ...f.callbacks, onLost: async () => {
    f.calls.lost++; lost.resolve(); await cleanup.promise;
  } })).toBe(true);
  expect(f.lease.ownerClaim().fence).toBe(1);
  f.backend.heartbeat = async () => ({ ...receipt(), active: false });
  const heartbeat = f.lease.pulse();
  await lost.promise;
  expect(() => f.lease.assertActive()).toThrow(WorkerOwnershipLost);
  const secondPulse = f.lease.pulse();
  expect(f.calls.register).toBe(1);
  cleanup.resolve();
  await Promise.all([heartbeat, secondPulse]);
  expect(f.calls.release).toBe(1);
  await f.lease.pulse();
  expect(f.lease.ownerClaim().fence).toBe(2);
  expect(f.calls.acquired).toBe(2);
  await f.lease.stop();
  expect(f.calls.lost).toBe(2);
});

test("local deadline denies new work immediately even while cleanup is waiting", async () => {
  const cleanup = deferred<void>(), lost = deferred<void>();
  const f = fixture();
  await f.lease.start({ ...f.callbacks, onLost: async () => { lost.resolve(); await cleanup.promise; } });
  f.time(29750);
  expect(() => f.lease.ownerClaim()).toThrow(WorkerOwnershipLost);
  await lost.promise;
  const reacquire = f.lease.pulse();
  expect(f.calls.register).toBe(1);
  cleanup.resolve();
  await reacquire;
  expect(f.calls.register).toBe(2);
  expect(f.lease.ownerClaim().fence).toBe(2);
  await f.lease.stop();
});

test("hung heartbeat times out, tears down work, and a late success never restores the retired fence", async () => {
  const reply = deferred<WorkerLeaseReceipt>();
  const f = fixture({ heartbeat: () => reply.promise });
  await f.lease.start(f.callbacks);
  await f.lease.pulse();
  expect(f.calls.lost).toBe(1);
  expect(() => f.lease.ownerClaim()).toThrow(WorkerOwnershipLost);
  reply.resolve(receipt(1));
  await reply.promise;
  expect(() => f.lease.ownerClaim()).toThrow(WorkerOwnershipLost);
  await f.lease.pulse();
  expect(f.lease.ownerClaim().fence).toBe(2);
  await f.lease.stop();
});

test("stop during acquisition cannot start work after the delayed acknowledgement arrives", async () => {
  const reply = deferred<WorkerLeaseReceipt>(), requested = deferred<void>();
  const f = fixture({ register: () => { requested.resolve(); return reply.promise; } });
  const start = f.lease.start(f.callbacks);
  await requested.promise;
  await f.lease.stop();
  reply.resolve(receipt());
  expect(await start).toBe(false);
  expect(f.calls.acquired).toBe(0);
  expect(f.calls.release).toBe(1);
  expect(() => f.lease.ownerClaim()).toThrow(WorkerOwnershipLost);
});

test("heartbeat and loss handling continue during awaited startup recovery", async () => {
  const startup = deferred<void>(), entered = deferred<void>();
  const f = fixture();
  const starting = f.lease.start({ ...f.callbacks, onAcquired: async () => { entered.resolve(); await startup.promise; } });
  await entered.promise;
  await f.lease.pulse();
  expect(f.calls.heartbeat).toBe(1);
  await f.lease.stop();
  expect(f.calls.lost).toBe(1);
  startup.resolve();
  expect(await starting).toBe(false);
});

test("failed teardown stops acquisition polling instead of overlapping uncertain old work", async () => {
  const f = fixture({ heartbeat: async () => ({ ...receipt(), active: false }) });
  await f.lease.start({ ...f.callbacks, onLost: async () => { throw new Error("runner destruction uncertain"); } });
  await expect(f.lease.pulse()).rejects.toThrow("runner destruction uncertain");
  await f.lease.pulse();
  expect(f.calls.register).toBe(1);
  expect(f.calls.release).toBe(0);
  expect(() => f.lease.ownerClaim()).toThrow(WorkerOwnershipLost);
});

test("a remotely renewed fence cannot be reused after local loss when release fails", async () => {
  const f = fixture({ heartbeat: async () => { throw new Error("connection lost"); }, release: async () => { throw new Error("offline"); } });
  await f.lease.start(f.callbacks);
  await f.lease.pulse();
  f.backend.register = async () => receipt(1);
  await f.lease.pulse();
  expect(f.calls.acquired).toBe(1);
  expect(() => f.lease.ownerClaim()).toThrow(WorkerOwnershipLost);
  f.backend.register = async () => receipt(2);
  await f.lease.pulse();
  expect(f.calls.acquired).toBe(2);
  expect(f.lease.ownerClaim().fence).toBe(2);
  await f.lease.stop();
});

test("round trip time consumes lease validity; stale acquisition acknowledgement cannot start work", async () => {
  const f = fixture();
  f.backend.register = async () => { f.time(30000); return receipt(); };
  expect(await f.lease.start(f.callbacks)).toBe(false);
  expect(f.calls.acquired).toBe(0);
  expect(() => f.lease.ownerClaim()).toThrow(WorkerOwnershipLost);
  await f.lease.stop();
});

test("startup recovery failure tears down ownership and is surfaced", async () => {
  const f = fixture();
  const start = f.lease.start({ ...f.callbacks, onAcquired: async () => { throw new Error("journal recovery failed"); } });
  await expect(start).rejects.toThrow("journal recovery failed");
  expect(f.calls.lost).toBe(1);
  expect(f.calls.release).toBe(1);
  expect(() => f.lease.ownerClaim()).toThrow(WorkerOwnershipLost);
});

test("work awaiting evidence under a retired fence cannot continue after this process reacquires", async () => {
  const evidence = deferred<void>(), entered = deferred<void>();
  const f = fixture();
  await f.lease.start(f.callbacks);
  let allocated = false;
  const oldJob = f.lease.withOwner(async () => {
    entered.resolve(); await evidence.promise;
    f.lease.assertActive(); allocated = true;
  });
  await entered.promise;
  f.backend.heartbeat = async () => ({ ...receipt(1), active: false });
  await f.lease.pulse();
  await f.lease.pulse();
  expect(f.lease.ownerClaim().fence).toBe(2);
  evidence.resolve();
  await expect(oldJob).rejects.toThrow(WorkerOwnershipLost);
  expect(allocated).toBe(false);
  // A timer created by old work may enter a fresh poll, but only the explicit entry boundary resets its fence.
  await f.lease.withOwner(async () => { expect(f.lease.ownerClaim().fence).toBe(2); });
  await f.lease.stop();
});

test("a fresh poll explicitly replaces an inherited stale timer context", async () => {
  const resume = deferred<void>(), started = deferred<void>();
  const f = fixture();
  await f.lease.start(f.callbacks);
  const oldTimer = f.lease.withOwner(async () => {
    started.resolve(); await resume.promise;
    expect(() => f.lease.assertActive()).toThrow(WorkerOwnershipLost);
    await f.lease.withOwner(async () => { expect(f.lease.ownerClaim().fence).toBe(2); });
  });
  await started.promise;
  f.backend.heartbeat = async () => ({ ...receipt(1), active: false });
  await f.lease.pulse(); await f.lease.pulse();
  resume.resolve(); await oldTimer;
  await f.lease.stop();
});
