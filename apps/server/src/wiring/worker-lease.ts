import { AsyncLocalStorage } from "node:async_hooks";

export type WorkerClaim = { ownerId: string; fence: number };
export type WorkerLeaseReceipt = { active: boolean; fence: number; expiresMs: number; serverNowMs: number };
export type WorkerLeaseBackend = {
  register(ownerId: string, ttlMs: number): Promise<WorkerLeaseReceipt>;
  heartbeat(owner: WorkerClaim, ttlMs: number): Promise<WorkerLeaseReceipt>;
  release(owner: WorkerClaim): Promise<unknown>;
};
export type WorkerLeaseCallbacks = { onAcquired(): Promise<void>; onLost(): Promise<void> };
export class WorkerOwnershipLost extends Error {
  constructor() { super("This process does not own an active workspace worker lease."); this.name = "WorkerOwnershipLost"; }
}

/** A follower serves reads but cannot start background work. Lease loss aborts work before ownership can be reacquired. */
export class RuntimeWorkerLease {
  readonly ownerId: string;
  private owner: WorkerClaim | null = null;
  private deadline = 0;
  private running = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<boolean> | null = null;
  private loss: Promise<void> | null = null;
  private startup: Promise<void> | null = null;
  private readonly context = new AsyncLocalStorage<WorkerClaim>();
  private retiredFence = 0;
  private callbacks: WorkerLeaseCallbacks | null = null;
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  constructor(private readonly backend: WorkerLeaseBackend, private readonly options: {
    ownerId?: string; ttlMs?: number; intervalMs?: number; now?: () => number; schedule?: boolean; requestTimeoutMs?: number;
  } = {}) {
    this.ownerId = options.ownerId ?? crypto.randomUUID();
    this.ttlMs = options.ttlMs ?? 30_000;
    this.intervalMs = options.intervalMs ?? 10_000;
    this.now = options.now ?? (() => performance.now());
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 5000 || this.ttlMs > 120000
      || !Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0 || this.intervalMs >= this.ttlMs / 2
      || (options.requestTimeoutMs != null && (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)))
      throw new Error("Invalid worker heartbeat configuration");
  }
  private async request<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WorkerOwnershipLost()), this.options.requestTimeoutMs ?? this.intervalMs);
    });
    try { return await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
  }
  private activeClaim(): WorkerClaim {
    if (!this.running || !this.owner || this.now() >= this.deadline) {
      if (this.owner) void this.lose().catch(() => undefined);
      throw new WorkerOwnershipLost();
    }
    return { ...this.owner };
  }
  ownerClaim(): WorkerClaim {
    const current = this.activeClaim(), captured = this.context.getStore();
    if (captured && (captured.ownerId !== current.ownerId || captured.fence !== current.fence)) throw new WorkerOwnershipLost();
    return current;
  }
  /** Entry boundary only: bind a new HTTP request or job poll to the currently active fence. */
  withOwner<T>(work: () => Promise<T>): Promise<T> { return this.context.run(this.activeClaim(), work); }
  assertActive(): void { this.ownerClaim(); }

  private clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.expiry) clearTimeout(this.expiry);
    this.timer = this.expiry = null;
  }
  private renewLater() {
    if (!this.running || this.options.schedule === false) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = this.context.exit(() => setTimeout(() => { this.timer = null; void this.pulse().catch(() => undefined); }, this.intervalMs));
    this.timer.unref?.();
  }
  private async lose(): Promise<void> {
    if (this.loss) return this.loss;
    if (!this.owner) return;
    const owner = this.owner;
    this.retiredFence = Math.max(this.retiredFence, owner.fence);
    this.owner = null; this.deadline = 0; this.generation++;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    const loss = this.context.exit(() => Promise.resolve().then(() => this.callbacks?.onLost())).then(async () => {
      // A timed-out heartbeat might have renewed remotely. Retire its fence after local work has stopped.
      await this.request(this.backend.release(owner)).catch(() => undefined);
    });
    this.loss = loss;
    try { await loss; }
    catch (error) { this.running = false; this.clearTimers(); throw error; }
    finally { if (this.loss === loss) this.loss = null; }
  }
  async start(callbacks: WorkerLeaseCallbacks): Promise<boolean> {
    if (this.running) { try { this.assertActive(); return true; } catch { return false; } }
    this.callbacks = callbacks; this.running = true;
    await this.pulse();
    try { this.assertActive(); return true; } catch { return false; }
  }
  /** Exposed for bounded offline tests and an operator-triggered ownership check. */
  async pulse(): Promise<void> {
    if (this.flight) { await this.flight; return; }
    const flight = this.check();
    this.flight = flight;
    let acquired = false;
    try { acquired = await flight; } finally { if (this.flight === flight) this.flight = null; }
    if (acquired) {
      const startup = this.withOwner(() => Promise.resolve().then(() => this.callbacks?.onAcquired()).then(() => undefined));
      this.startup = startup;
      try { await startup; }
      catch (error) { this.running = false; this.clearTimers(); await this.lose(); throw error; }
      finally { if (this.startup === startup) this.startup = null; }
    }
  }
  private async check(): Promise<boolean> {
    if (!this.running) return false;
    if (this.loss) await this.loss;
    if (!this.owner && this.startup) await this.startup.catch(() => undefined);
    if (!this.running) return false;
    if (this.owner && this.now() >= this.deadline) await this.lose();
    const generation = this.generation, previous = this.owner;
    const sentAt = this.now();
    try {
      const receipt = await this.request(previous ? this.backend.heartbeat(previous, this.ttlMs) : this.backend.register(this.ownerId, this.ttlMs));
      if (!this.running || generation !== this.generation) {
        if (receipt.active && !this.running) await this.request(this.backend.release({ ownerId: this.ownerId, fence: receipt.fence }));
        return false;
      }
      if (!receipt.active) { if (previous) await this.lose(); return false; }
      if (!previous && receipt.fence <= this.retiredFence) {
        await this.request(this.backend.release({ ownerId: this.ownerId, fence: receipt.fence }));
        return false;
      }
      const remaining = receipt.expiresMs - receipt.serverNowMs - (this.now() - sentAt) - 250;
      if (!Number.isSafeInteger(receipt.fence) || receipt.fence <= 0 || !Number.isFinite(remaining) || remaining <= 0
        || remaining > this.ttlMs || (previous && receipt.fence !== previous.fence)) {
        if (previous) await this.lose();
        return false;
      }
      this.owner = { ownerId: this.ownerId, fence: receipt.fence };
      this.deadline = this.now() + remaining;
      if (this.expiry) clearTimeout(this.expiry);
      if (this.options.schedule !== false) {
        this.expiry = this.context.exit(() => setTimeout(() => { void this.lose().catch(() => undefined); }, remaining));
        this.expiry.unref?.();
      }
      return !previous;
    } catch (error) {
      if (this.owner) await this.lose();
      if (!this.running) throw error;
      return false;
    } finally { this.renewLater(); }
  }
  async stop(): Promise<void> {
    this.running = false; this.generation++; this.clearTimers();
    await this.lose();
  }
}

