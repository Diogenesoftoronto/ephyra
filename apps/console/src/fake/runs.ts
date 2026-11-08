// Fictional agent runs and their event streams (fixtures for the Runs list and Run view).
// Tool arguments and results are short, already-redacted text, as the server would store them.
import type { AgentRun, AgentRunEvent, PersonaId, Trail } from "@ephyra/core";
import { demoRunVisual } from "./run-visual.ts";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

export const RUN_IDS = {
  orb: "run-orb-7qm2x",
  local: "run-local-48213",
  failed: "run-runner-hk3",
  unavailable: "run-local-none",
  sandbox: "run-railway-9c1",
} as const;

type EventInit = Omit<AgentRunEvent, "runId" | "seq" | "at"> & { dt: number };

class Script {
  readonly events: AgentRunEvent[] = [];
  constructor(
    private readonly runId: string,
    private readonly start: number,
    private seq = 0,
  ) {}
  add(e: EventInit): this {
    const { dt, ...rest } = e;
    this.events.push({ runId: this.runId, seq: this.seq++, at: iso(this.start + dt), ...rest });
    return this;
  }
}

const trailIdOf = (trails: Trail[], hex: string) => trails.find((t) => t.short === `T-${hex}`)!;

export type RunBundle = {
  run: AgentRun;
  events: AgentRunEvent[];
  /** Events that arrive live after the first page. */ tail: AgentRunEvent[];
};

export function makeRuns(trails: Trail[], now: number): RunBundle[] {
  const mk = (
    id: string,
    hex: string,
    persona: PersonaId,
    step: string,
    rest: Omit<AgentRun, "id" | "trailId" | "short" | "persona" | "step">,
  ): AgentRun => {
    const t = trailIdOf(trails, hex);
    return { id, trailId: t.id, short: t.short, persona, step, ...rest };
  };

  // 1. Amp orb, running: a patch for the tax rounding fix, with a plugin rejection and a portal link.
  const orbStart = now - 6 * MIN;
  const orb = new Script(RUN_IDS.orb, orbStart)
    .add({ dt: 0, type: "status", text: "Started on orb orb_7Qm2x (storefront)" })
    .add({
      dt: 4_000,
      type: "message",
      text: "I'll read the tax summary module first, then write a test for the rounding case.",
    })
    .add({
      dt: 6_000,
      type: "tool_call",
      tool: { callId: "c1", name: "read_file", args: '{"path":"src/billing/tax-summary.ts"}' },
    })
    .add({
      dt: 7_000,
      type: "tool_result",
      tool: {
        callId: "c1",
        name: "read_file",
        result: "export function summarise(lines) {\n  // ...312 lines\n}",
      },
    })
    .add({
      dt: 11_000,
      type: "reasoning",
      text: "Rounding happens per line, then the sum is rounded again. Summing first and rounding once fixes the 1-cent drift.",
    })
    .add({
      dt: 20_000,
      type: "tool_call",
      tool: {
        callId: "c2",
        name: "edit_file",
        args: '{"path":"src/billing/tax-summary.ts","lines":"88-96"}',
      },
    })
    .add({
      dt: 20_400,
      type: "policy",
      tool: { callId: "c2", name: "edit_file" },
      policy: { decision: "allow", rule: "area:billing/paths", reason: "Path is inside the billing area." },
    })
    .add({
      dt: 21_000,
      type: "tool_result",
      tool: { callId: "c2", name: "edit_file", result: "Edited 9 lines." },
    })
    .add({
      dt: 60_000,
      type: "tool_call",
      tool: { callId: "c3", name: "bash", args: '{"cmd":"git push origin HEAD:refs/heads/main"}' },
    })
    .add({
      dt: 60_300,
      type: "policy",
      tool: { callId: "c3", name: "bash" },
      policy: {
        decision: "reject",
        rule: "protected-ref",
        reason: "push to protected ref blocked: refs/heads/main",
      },
    })
    .add({
      dt: 60_500,
      type: "tool_result",
      tool: {
        callId: "c3",
        name: "bash",
        result: "Blocked by Ephyra policy (protected-ref).",
        isError: true,
      },
    })
    .add({
      dt: 64_000,
      type: "message",
      text: "Pushing to `main` is blocked. I'll push to the trail ref instead and let the proof run decide.",
    })
    .add({
      dt: 66_000,
      type: "tool_call",
      tool: {
        callId: "c4",
        name: "bash",
        args: '{"cmd":"git push origin HEAD:refs/ephyra/trails/T-a44d52"}',
      },
    })
    .add({
      dt: 66_200,
      type: "policy",
      tool: { callId: "c4", name: "bash" },
      policy: {
        decision: "modify",
        rule: "trail-ref-only",
        reason: "Added --force-with-lease=none; force pushes are removed.",
      },
    })
    .add({
      dt: 67_000,
      type: "tool_result",
      tool: {
        callId: "c4",
        name: "bash",
        result: "To forge.example:acme/storefront\n * [new branch]  HEAD -> refs/ephyra/trails/T-a44d52",
      },
    })
    .add({
      dt: 70_000,
      type: "portal",
      portalUrl: "https://orb-7qm2x.portal.example/",
      text: "Preview is live",
    })
    .add({ dt: 72_000, type: "message", text: "Fictional demo: an interactive explanation of the rounding change.", visual: demoRunVisual });
  // The live tail continues the same sequence numbers.
  const tailScript = new Script(RUN_IDS.orb, orbStart, orb.events.length);
  tailScript
    .add({
      dt: 90_000,
      type: "tool_call",
      tool: { callId: "c5", name: "bash", args: '{"cmd":"bun test packages/billing"}' },
    })
    .add({
      dt: 118_000,
      type: "tool_result",
      tool: { callId: "c5", name: "bash", result: "42 pass\n0 fail" },
    })
    .add({
      dt: 121_000,
      type: "message",
      text: "Tests pass with the rounding fix. Writing the summary for the proof run.",
    })
    .add({ dt: 124_000, type: "status", text: "Waiting for the proof runner" });

  // 2. Claude Code, local process, done: research for the double coupon failure.
  const localStart = now - 55 * MIN;
  const local = new Script(RUN_IDS.local, localStart)
    .add({ dt: 0, type: "status", text: "Started local process 48213" })
    .add({
      dt: 2_000,
      type: "message",
      text: "Looking for where a coupon is applied and whether the order row is locked first.",
    })
    .add({
      dt: 5_000,
      type: "tool_call",
      tool: { callId: "l1", name: "grep", args: '{"pattern":"applyCoupon","path":"src"}' },
    })
    .add({
      dt: 5_600,
      type: "tool_result",
      tool: { callId: "l1", name: "grep", result: "src/checkout/coupons.ts:41\nsrc/checkout/order.ts:118" },
    })
    .add({
      dt: 30_000,
      type: "reasoning",
      text: "The coupon flag is read at line 41 before the transaction opens at line 118.",
    })
    .add({
      dt: 90_000,
      type: "message",
      text: "Hypothesis written: a second apply passes the check because the read is outside the lock.",
    })
    .add({ dt: 91_000, type: "status", text: "Done. 62k tokens." });

  // 3. Codex on a runner, failed.
  const failedStart = now - 95 * MIN;
  const failed = new Script(RUN_IDS.failed, failedStart)
    .add({ dt: 0, type: "status", text: "Started on runner runner-hk-3 (storefront)" })
    .add({ dt: 3_000, type: "message", text: "Patching the refund handler to take an idempotency key." })
    .add({
      dt: 9_000,
      type: "tool_call",
      tool: { callId: "f1", name: "edit_file", args: '{"path":"src/refunds/refund.ts"}' },
    })
    .add({
      dt: 9_400,
      type: "tool_result",
      tool: { callId: "f1", name: "edit_file", result: "Edited 14 lines." },
    })
    .add({
      dt: 40_000,
      type: "tool_call",
      tool: { callId: "f2", name: "bash", args: '{"cmd":"bunx tsc --noEmit"}' },
    })
    .add({
      dt: 52_000,
      type: "tool_result",
      tool: {
        callId: "f2",
        name: "bash",
        isError: true,
        result:
          "src/refunds/refund.ts(31,9): error TS2322: Type 'string' is not assignable to type 'IdemKey'.",
      },
    })
    .add({ dt: 53_000, type: "status", text: "Failed: patch did not compile" });

  // 4. Unavailable: the engine is not installed.
  const unavailable = new Script(RUN_IDS.unavailable, now - 12 * MIN).add({
    dt: 0,
    type: "status",
    text: "Unverified: claude-code is not installed on this runner. Nothing ran.",
  });

  // 5. Railway sandbox, done: a proof run.
  const sandboxStart = now - 40 * MIN;
  const sandbox = new Script(RUN_IDS.sandbox, sandboxStart)
    .add({ dt: 0, type: "status", text: "Started Railway sandbox sbx-9c1" })
    .add({
      dt: 12_000,
      type: "tool_call",
      tool: { callId: "s1", name: "bash", args: '{"cmd":"ephyra-proof run --trail T-c2d018"}' },
    })
    .add({
      dt: 400_000,
      type: "tool_result",
      tool: {
        callId: "s1",
        name: "bash",
        result: "repro_after: pass\ntests: 212 pass, 0 fail\nregression probes: clean",
      },
    })
    .add({ dt: 405_000, type: "status", text: "Done. Proof bundle written." });

  const runs: RunBundle[] = [
    {
      run: mk(RUN_IDS.orb, "a44d52", "lappet", "patch", {
        engine: "amp/smart",
        status: "running",
        startedAt: iso(orbStart),
        executor: {
          kind: "orb",
          id: "orb_7Qm2x",
          project: "storefront",
          portalUrl: "https://orb-7qm2x.portal.example/",
          threadUrl: "https://ampcode.com/threads/T-019e3c10-7a2e-7000-8c1d-5f0b2f6e9a11",
        },
        usage: { tokens: 88_000, costMicrousd: null },
      }),
      events: orb.events,
      tail: tailScript.events,
    },
    {
      run: mk(RUN_IDS.local, "7f3a2c", "bell", "research", {
        engine: "claude-code/claude-opus-5-5",
        status: "done",
        startedAt: iso(localStart),
        endedAt: iso(localStart + 91_000),
        executor: { kind: "local", id: "pid 48213" },
        usage: { tokens: 62_000, costMicrousd: 410_000 },
      }),
      events: local.events,
      tail: [],
    },
    {
      run: mk(RUN_IDS.failed, "3a77e1", "lappet", "patch", {
        engine: "codex/gpt-6-codex",
        status: "failed",
        startedAt: iso(failedStart),
        endedAt: iso(failedStart + 53_000),
        executor: { kind: "runner", id: "runner-hk-3", project: "storefront" },
        usage: { tokens: 45_000, costMicrousd: 310_000 },
        error: "Patch did not compile: type error in refund.ts",
      }),
      events: failed.events,
      tail: [],
    },
    {
      run: mk(RUN_IDS.unavailable, "58f0aa", "nema", "repro", {
        engine: "claude-code/claude-opus-5-5",
        status: "unavailable",
        startedAt: iso(now - 12 * MIN),
        endedAt: iso(now - 12 * MIN),
        executor: { kind: "local" },
        error: "Unverified: claude-code is not installed on this runner",
      }),
      events: unavailable.events,
      tail: [],
    },
    {
      run: mk(RUN_IDS.sandbox, "c2d018", "nema", "proof", {
        engine: "runner/devenv-sandbox",
        status: "done",
        startedAt: iso(sandboxStart),
        endedAt: iso(sandboxStart + 405_000),
        executor: { kind: "railway", id: "sbx-9c1", project: "storefront" },
        usage: { tokens: null, costMicrousd: 0 },
      }),
      events: sandbox.events,
      tail: [],
    },
  ];
  return runs;
}
