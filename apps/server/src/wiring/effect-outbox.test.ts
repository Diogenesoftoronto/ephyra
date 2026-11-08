import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import fc from "fast-check";
import { Trail, TrailEvent, type Effect, type TransitionContext } from "@ephyra/core";
import { GitJournal } from "@ephyra/journal";
import type { EffectHandlers } from "../orchestrator.ts";
import { KnowledgeOperationLedger } from "../setup/knowledge-ledger.ts";
import { Engine, JobLoop } from "./runtime.ts";
import { MemoryStore } from "./store.ts";
import { appendEffects, effectOutbox, EFFECT_OUTBOX_PATH, readEffectOutbox } from "./effect-outbox.ts";
import { WorkerOwnershipLost } from "./worker-lease.ts";

const directories: string[] = [];
const loops: JobLoop[] = [];
afterEach(async () => {
  loops.splice(0).forEach(loop => loop.stop());
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const id = "019cc100-0000-7000-8000-000000000001";
const at = "2026-11-08T10:00:00.000Z";
const context: TransitionContext = { now: at, blocking: { A: true, B: true, C: true }, landingModes: ["trail_ref"] };
const trail = () => Trail.parse({ schema: 1, id, short: "T-000001", repo: "fixture", title: "Outbox repair", rev: 1,
  state: "researching", signals: [id], area: "application", risk: "low", route: "auto_fix", severity: 1,
  base: { ref: "refs/heads/main", sha: "a".repeat(40) }, checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
  budget: { tokensUsed: 0, tokensMax: 10, wallclockMaxS: 600, spendMicrousdUsed: 0, spendMicrousdMax: 100 },
  mirrors: {}, createdAt: at, updatedAt: at });
const first = () => TrailEvent.parse({ schema: 1, id: crypto.randomUUID(), trail: id, rev: 1, at,
  actor: { kind: "system", id: "fixture" }, type: "trail_created", data: {
    signalId: id, title: "Outbox repair", baseRef: "refs/heads/main", baseSha: "a".repeat(40),
  } });

test("arbitrary effect notes retain an immutable snapshot and exact repeated plans stay idempotent", () => {
  fc.assert(fc.property(fc.string({ maxLength: 120 }), fc.string({ maxLength: 120 }), (key, note) => {
    const snapshot = trail();
    const eventId = first().id;
    const effect: Effect = { type: "start_agent", key, step: "research", note };
    const entries = appendEffects([], eventId, snapshot, [effect]);
    expect(effectOutbox(appendEffects(entries, eventId, snapshot, [effect]))).toBe(effectOutbox(entries));
    snapshot.title = "changed after journal planning";
    expect(entries[0]!.trail.title).toBe("Outbox repair");
    expect(() => appendEffects(entries, eventId, trail(), [{ ...effect, note: note + "changed" }])).toThrow("operation key changed");
  }), { numRuns: 75 });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-durable-outbox-"));
  directories.push(directory);
  const gitDir = join(directory, "journal.git");
  expect(await Bun.spawn(["git", "init", "--bare", "-q", gitDir], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
  let store = new MemoryStore();
  let owned = true;
  let hook: ((effect: Effect) => Promise<void>) | undefined;
  const calls: { effect: Effect; snapshot: Trail }[] = [];
  const make = () => {
    const journal = new GitJournal({ gitDir, clock: { now: () => new Date(at) } });
    const ledger = new KnowledgeOperationLedger(join(directory, "operations"));
    const engine = new Engine(store, journal, ledger, async () => context, { uuidv7: () => crypto.randomUUID() }, () => {});
    engine.setOwnershipGuard(() => { if (!owned) throw new Error("namespace ownership lost"); });
    const handlers = new Proxy({}, { get: () => async (effect: Effect, snapshot: Trail) => {
      calls.push({ effect, snapshot }); await hook?.(effect);
    } }) as EffectHandlers;
    engine.setHandlers(handlers);
    return { engine, journal, ledger };
  };
  let current = make();
  const restart = (clearProjection = false) => {
    if (clearProjection) store = new MemoryStore();
    current = make();
    return current;
  };
  return { initial: first(), current: () => current, store: () => store, calls, restart,
    hook: (callback: (effect: Effect) => Promise<void>) => { hook = callback; }, owned: (value: boolean) => { owned = value; } };
}

test("a journaled budget stop survives projection failure, real Git/file-ledger reconstruction and keyed replay", async () => {
  const f = await fixture();
  await f.current().engine.start(trail(), f.initial);
  const put = f.store().putTrail.bind(f.store());
  let fail = true;
  f.store().putTrail = async value => { if (fail) { fail = false; throw new Error("projection unavailable"); } await put(value); };
  const input = { trail: id, actor: { kind: "system" as const, id: "usage" }, eventId: crypto.randomUUID(),
    type: "usage_recorded" as const, data: { operationKey: "provider-turn", tokens: 11, costMicrousd: 0, wallMs: 1 } };
  await expect(f.current().engine.emit(input)).rejects.toThrow("projection unavailable");
  expect((await f.current().journal.read(id))!.trail.state).toBe("parked");
  expect((await f.store().getTrail(id))!.state).toBe("researching");
  expect((await readEffectOutbox(f.current().journal, id)).map(entry => entry.effect.type)).toContain("stop_agent");
  expect(f.calls).toHaveLength(0);
  const restarted = f.restart(true);
  await restarted.engine.recoverEffects();
  expect((await f.store().getTrail(id))!.state).toBe("parked");
  expect(f.calls.filter(call => call.effect.type === "stop_agent")).toHaveLength(1);
  await restarted.engine.emit(input);
  await f.restart(true).engine.recoverEffects();
  expect(f.calls.filter(call => call.effect.type === "stop_agent")).toHaveLength(1);
  expect((await f.store().getTrail(id))!.budget.tokensUsed).toBe(11);
  expect((await f.store().events(id)).filter(event => event.type === "usage_recorded")).toHaveLength(1);
});

test("a newly created journal absent from the projection is discovered and its initial effect delivered once", async () => {
  const f = await fixture();
  f.store().putTrail = async () => { throw new Error("projection unavailable"); };
  const effect: Effect = { type: "start_agent", key: "new-trail-research", step: "research" };
  await expect(f.current().engine.start(trail(), f.initial, [effect])).rejects.toThrow("projection unavailable");
  expect(await f.store().listTrails()).toEqual([]);
  await f.restart(true).engine.recoverEffects();
  expect((await f.store().getTrail(id))!.state).toBe("researching");
  expect(f.calls.map(call => call.effect.key)).toEqual([effect.key]);
  await f.restart(true).engine.recoverEffects();
  expect(f.calls).toHaveLength(1);
});

test("failure between trail projection and event projection retains the full effect plan", async () => {
  const f = await fixture();
  await f.current().engine.start(trail(), f.initial);
  f.store().recordEvent = async () => { throw new Error("event projection unavailable"); };
  await expect(f.current().engine.emit({ trail: id, actor: { kind: "agent", id: "fixture" }, type: "research_completed",
    data: { hypothesis: "hypothesis.md" } })).rejects.toThrow("event projection unavailable");
  await f.restart(true).engine.recoverEffects();
  expect(f.calls.map(call => call.effect.type)).toEqual(["request_checkpoint"]);
  expect((await f.store().events(id)).map(event => event.type)).toEqual(["trail_created", "research_completed"]);
  const snapshot = f.calls[0]!.snapshot;
  expect(snapshot.state).toBe("hypothesised");
  await f.current().engine.emit({ trail: id, actor: { kind: "human", id: "owner" }, type: "human_comment",
    data: { text: "More context", isRequest: false } });
  await f.restart(true).engine.recoverEffects();
  expect(f.calls.filter(call => call.effect.type === "request_checkpoint")).toHaveLength(1);
});

test("an uncertain external effect remains blocked across restarts and changed trail snapshots", async () => {
  const f = await fixture();
  f.hook(async () => { throw new Error("external response lost"); });
  await f.current().engine.start(trail(), f.initial, [{ type: "start_agent", key: "uncertain-provider", step: "research" }]);
  expect(f.calls).toHaveLength(1);
  expect((await f.current().ledger.get("uncertain-provider"))!.status).toBe("reconciliation_required");
  await f.restart(true).engine.recoverEffects();
  expect(f.calls).toHaveLength(1);
  expect(f.current().engine.reconciliations[0]!.key).toBe("uncertain-provider");
});

test("a later kill supersedes an unclaimed research effect without reviving it on restart", async () => {
  const f = await fixture();
  f.store().putTrail = async () => { throw new Error("projection unavailable"); };
  await expect(f.current().engine.start(trail(), f.initial,
    [{ type: "start_agent", key: "superseded-research", step: "research" }])).rejects.toThrow();
  f.restart(true);
  await f.current().engine.emit({ trail: id, actor: { kind: "human", id: "owner" }, type: "killed", data: { reason: "Stop" } });
  expect(f.calls.filter(call => call.effect.type === "start_agent")).toHaveLength(0);
  expect(f.calls.filter(call => call.effect.type === "stop_agent")).toHaveLength(1);
  expect((await readEffectOutbox(f.current().journal, id)).some(entry => entry.effect.key === "superseded-research")).toBe(false);
  await f.restart(true).engine.recoverEffects();
  expect(f.calls.filter(call => call.effect.type === "start_agent")).toHaveLength(0);
});

test("nested event delivery skips its in-flight parent effect and preserves its original receipt digest", async () => {
  const f = await fixture();
  f.hook(async effect => {
    if (effect.type === "start_agent") await f.current().engine.emit({ trail: id, actor: { kind: "agent", id: "fixture" },
      type: "research_completed", data: { hypothesis: "hypothesis.md" } });
  });
  await f.current().engine.start(trail(), f.initial, [{ type: "start_agent", key: "nested-research", step: "research" }]);
  expect(f.calls.map(call => call.effect.type)).toEqual(["start_agent", "request_checkpoint"]);
  expect((await f.current().ledger.get("nested-research"))!.status).toBe("done");
  await f.restart(true).engine.recoverEffects();
  expect(f.calls).toHaveLength(2);
});

test("ownership is required before journal creation, projection recovery and effect delivery", async () => {
  const f = await fixture();
  f.owned(false);
  await expect(f.current().engine.start(trail(), f.initial)).rejects.toThrow("ownership lost");
  expect(await f.current().journal.list()).toEqual([]);
  f.owned(true);
  await f.current().engine.start(trail(), f.initial);
  f.owned(false);
  await expect(f.restart(true).engine.recoverEffects()).rejects.toThrow("ownership lost");
  expect(await f.store().listTrails()).toEqual([]);
  f.owned(true);
  await f.current().engine.recoverEffects();
  expect((await f.store().getTrail(id))!.id).toBe(id);
});

test("corrupt durable outboxes fail closed rather than silently discarding work", async () => {
  const f = await fixture();
  await f.current().engine.start(trail(), f.initial);
  const current = (await f.current().journal.read(id))!;
  await f.current().journal.append(id, current.head, current.trail, [], { [EFFECT_OUTBOX_PATH]: "{broken" });
  await expect(f.restart(true).engine.recoverEffects()).rejects.toThrow("corrupt durable effect outbox");
  expect(f.calls).toHaveLength(0);
});

test("projection recovery permits policy invalidation before an old pending landing can execute", async () => {
  const f = await fixture();
  const ready = Trail.parse({ ...trail(), state: "ready", head: "b".repeat(40) });
  f.store().putTrail = async () => { throw new Error("projection unavailable"); };
  await expect(f.current().engine.start(ready, f.initial,
    [{ type: "land", key: "old-policy-landing", modes: ["auto_land"] }])).rejects.toThrow();
  const restarted = f.restart(true);
  await restarted.engine.recoverProjections();
  expect(f.calls).toHaveLength(0);
  expect((await f.store().getTrail(id))!.state).toBe("ready");
  await restarted.engine.emit({ trail: id, actor: { kind: "system", id: "policy-activation" }, type: "policy_updated",
    data: { commit: "c".repeat(40), path: "autonomy.md", risk: "high", area: "application" } });
  await restarted.engine.recoverEffects(undefined, { project: false });
  expect(f.calls.some(call => call.effect.type === "land")).toBe(false);
  expect((await f.store().getTrail(id))!.policyCommit).toBe("c".repeat(40));
  await f.restart(true).engine.recoverEffects();
  expect(f.calls.some(call => call.effect.type === "land")).toBe(false);
});

test("reopening a closed regression commits its new state and initial effects to the existing journal", async () => {
  const f = await fixture();
  const closed = Trail.parse({ ...trail(), state: "closed" });
  await f.current().engine.start(closed, f.initial);
  const reopened = Trail.parse({ ...closed, rev: 2, state: "researching" });
  const initial = TrailEvent.parse({ ...first(), rev: 2 });
  const effect: Effect = { type: "start_agent", key: "regression-research", step: "research" };
  await f.current().engine.start(reopened, initial, [effect]);
  expect((await f.current().journal.read(id))!.trail).toMatchObject({ rev: 2, state: "researching" });
  expect((await f.current().journal.read(id))!.events).toHaveLength(2);
  await f.restart(true).engine.recoverEffects();
  expect(f.calls.filter(call => call.effect.key === effect.key)).toHaveLength(1);
});

test("losing ownership after the durable ledger claim cannot dispatch an external effect", async () => {
  const f = await fixture();
  const ledger = f.current().ledger;
  const begin = ledger.begin.bind(ledger);
  ledger.begin = async (key, plan) => {
    const claimed = await begin(key, plan);
    f.owned(false);
    return claimed;
  };
  await f.current().engine.start(trail(), f.initial, [{ type: "start_agent", key: "fenced-provider", step: "research" }]);
  expect(f.calls).toHaveLength(0);
  expect((await ledger.get("fenced-provider"))!.status).toBe("reconciliation_required");
  f.owned(true);
  await f.restart(true).engine.recoverEffects();
  expect(f.calls).toHaveLength(0);
});

test("job ownership fences both claims and work that loses its lease immediately after claiming", async () => {
  class OwnedStore extends MemoryStore {
    owned = false;
    loseAfterClaim = false;
    assertOwner() { if (!this.owned) throw new Error("owner lost"); }
    override async claim(now: Date, count: number) {
      const jobs = await super.claim(now, count);
      if (this.loseAfterClaim) this.owned = false;
      return jobs;
    }
  }
  const store = new OwnedStore();
  const loop = new JobLoop(store, () => {});
  loops.push(loop);
  let externalCalls = 0;
  loop.register("provider", async () => { externalCalls++; });
  await loop.enqueue("provider", "provider-operation", {});
  expect(await loop.tick()).toBe(0);
  expect(externalCalls).toBe(0);
  store.owned = true;
  store.loseAfterClaim = true;
  await loop.tick();
  expect(externalCalls).toBe(0);
  expect((await store.activeJobs())[0]!.status).toBe("running");
});

test("enqueueing a job does not start its execution before the job loop is explicitly started", async () => {
  const store = new MemoryStore();
  const loop = new JobLoop(store, () => {});
  loops.push(loop);
  let calls = 0;
  loop.register("provider", async () => { calls++; });
  await loop.enqueue("provider", "not-started", {});
  await Bun.sleep(20);
  expect(calls).toBe(0);
  expect((await store.activeJobs())[0]!.status).toBe("queued");
  await loop.tick();
  expect(calls).toBe(1);
});

test.each(["return", "throw", "finish", "fail"] as const)(
  "ownership lost during a job's %s leaves its external result for reconciliation without retry", async phase => {
    class OwnedStore extends MemoryStore {
      owned = true;
      finishes = 0;
      failures = 0;
      assertOwner() { if (!this.owned) throw new WorkerOwnershipLost(); }
      override async finish(key: string) {
        this.finishes++;
        if (phase === "finish") throw new WorkerOwnershipLost();
        await super.finish(key);
      }
      override async fail(key: string, error: string, runAt: Date, dead: boolean) {
        this.failures++;
        if (phase === "fail") { this.owned = false; throw new WorkerOwnershipLost(); }
        await super.fail(key, error, runAt, dead);
      }
    }
    const store = new OwnedStore();
    const logs: string[] = [];
    const loop = new JobLoop(store, message => { logs.push(message); });
    loops.push(loop);
    let calls = 0;
    loop.register("provider", async () => {
      calls++;
      if (phase === "return" || phase === "throw") store.owned = false;
      if (phase === "throw" || phase === "fail") throw new Error("provider response lost");
    });
    await loop.enqueue("provider", `lost-during-${phase}`, {});
    expect(await loop.tick()).toBe(1);
    expect(store.finishes).toBe(phase === "finish" ? 1 : 0);
    expect(store.failures).toBe(phase === "fail" ? 1 : 0);
    expect((await store.activeJobs())[0]!.status).toBe("running");
    expect(logs).toContain("job ownership lost; reconciliation required");
    store.owned = true;
    expect(await loop.tick()).toBe(0);
    expect(calls).toBe(1);
  });

test("scheduled polling catches a failed claim and resumes without an unhandled rejection", async () => {
  class IntermittentStore extends MemoryStore {
    claims = 0;
    override async claim(now: Date, count: number) {
      if (++this.claims === 1) throw new WorkerOwnershipLost();
      return super.claim(now, count);
    }
  }
  const store = new IntermittentStore();
  const logs: { message: string; data: unknown }[] = [];
  const loop = new JobLoop(store, (message, data) => { logs.push({ message, data }); },
    { concurrency: 1, pollMs: 5, maxAttempts: 3 });
  loops.push(loop);
  let calls = 0;
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  loop.register("provider", async () => { calls++; complete(); });
  await loop.enqueue("provider", "poll-recovery", {});
  loop.start();
  await completed;
  loop.stop();
  expect(calls).toBe(1);
  expect(store.claims).toBe(2);
  expect(logs).toEqual([{ message: "job polling failed", data: { error: "WorkerOwnershipLost" } }]);
}, 1000);

test("a job awaiting evidence cannot use a replacement owner's fence to start an external request", async () => {
  class BoundStore extends MemoryStore {
    fence = 1;
    context = new AsyncLocalStorage<number>();
    assertOwner() {
      if (this.context.getStore() !== undefined && this.context.getStore() !== this.fence) throw new WorkerOwnershipLost();
    }
    withOwner<T>(work: () => Promise<T>): Promise<T> { return this.context.run(this.fence, work); }
  }
  const store = new BoundStore();
  const loop = new JobLoop(store, () => {});
  loops.push(loop);
  let resume!: () => void;
  let entered!: () => void;
  const evidence = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let externalCalls = 0;
  loop.register("provider", async () => {
    entered();
    await evidence;
    store.assertOwner();
    externalCalls++;
  });
  await loop.enqueue("provider", "old-awaiting-evidence", {});
  const running = loop.tick();
  await started;
  store.fence = 2;
  resume();
  await running;
  expect(externalCalls).toBe(0);
  expect((await store.activeJobs())[0]!.status).toBe("running");
  expect(await loop.tick()).toBe(0);
});

test("a fresh poll uses the current physical owner even if its timer inherited a retired context", async () => {
  class BoundStore extends MemoryStore {
    fence = 1;
    context = new AsyncLocalStorage<number>();
    assertOwner() { if (this.context.getStore() !== this.fence) throw new WorkerOwnershipLost(); }
    withOwner<T>(work: () => Promise<T>): Promise<T> { return this.context.run(this.fence, work); }
  }
  const store = new BoundStore();
  const loop = new JobLoop(store, () => {});
  loops.push(loop);
  let calls = 0;
  loop.register("provider", async () => { store.assertOwner(); calls++; });
  await loop.enqueue("provider", "fresh-owner-poll", {});
  await store.withOwner(async () => {
    store.fence = 2;
    expect(await loop.tick()).toBe(1);
  });
  expect(calls).toBe(1);
  expect(await store.activeJobs()).toEqual([]);
});
