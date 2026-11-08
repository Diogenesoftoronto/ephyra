import { expect, test } from "bun:test";
import type { Runner, RunnerHandle } from "@ephyra/core";
import { WorkControl } from "./control.ts";

const handle: RunnerHandle = { id: "real-handle", runner: "fixture", workdir: "/workspace", trailId: "trail", attempt: 1,
  leaseExpiresAt: "2026-11-09T00:00:00.000Z" };

test("stop aborts the active command and cleanup happens exactly once", async () => {
  const control = new WorkControl();
  const started = Promise.withResolvers<void>();
  let destructions = 0;
  const runner = { name: "fixture", allocate: async () => handle,
    destroy: async () => { destructions++; return { destroyed: true as const, at: "2026-11-08T00:00:00.000Z" }; },
    exec: async function* (_handle: RunnerHandle, _argv: string[], options: { signal: AbortSignal }) {
      started.resolve();
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { exit: 137, durationMs: 1, timedOut: false };
    } } as unknown as Runner;
  const work = control.run("trail", runner, async (active) => {
    const allocated = await active.allocate({} as Parameters<Runner["allocate"]>[0]);
    try { for await (const _part of active.exec(allocated, ["run"], { deadlineMs: 10_000 })) {} }
    finally { await active.destroy(allocated); }
  });
  // Attach a rejection handler before signalling cancellation.
  const outcome = work.then(() => "completed", () => "cancelled");
  await started.promise;
  const receipts = await control.stop("trail");
  expect(await outcome).toBe("cancelled");
  expect(destructions).toBe(1);
  expect(receipts).toEqual([{ handleId: handle.id, status: "destroyed", at: "2026-11-08T00:00:00.000Z" }]);
});

test("an allocation which returns after cancellation is destroyed before any work can run", async () => {
  const control = new WorkControl();
  const allocated = Promise.withResolvers<RunnerHandle>();
  let destructions = 0, commands = 0;
  const runner = { allocate: () => allocated.promise,
    destroy: async () => { destructions++; return { destroyed: true as const, at: new Date().toISOString() }; },
  } as unknown as Runner;
  const work = control.run("trail", runner, async (active) => {
    await active.allocate({} as Parameters<Runner["allocate"]>[0]);
    commands++;
  }).catch(() => "cancelled");
  expect(await control.stop("trail")).toEqual([{ handleId: null, status: "pending_allocation" }]);
  allocated.resolve(handle);
  expect(await work).toBe("cancelled");
  expect(destructions).toBe(1);
  expect(commands).toBe(0);
});

test("unknown teardown is reported as uncertain, never successful", async () => {
  const control = new WorkControl();
  const ready = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const runner = { allocate: async () => handle, destroy: async () => { throw new Error("lost response"); } } as unknown as Runner;
  const work = control.run("trail", runner, async (active) => {
    await active.allocate({} as Parameters<Runner["allocate"]>[0]); ready.resolve(); await finish.promise;
  });
  await ready.promise;
  expect(await control.stop("trail")).toEqual([{ handleId: handle.id, status: "reconciliation_required" }]);
  finish.resolve(); await work;
});
