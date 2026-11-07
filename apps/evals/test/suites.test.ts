import { test, expect } from "bun:test";
import { loadCorpus } from "../src/data";
import { runTriage } from "../src/triage";
import { runAgent, measuredContractFailure } from "../src/agent";
import { runInjection } from "../src/injection";
import { runProof } from "../src/proof";
import { runFeedback } from "../src/feedback";
import { Telemetry } from "../src/telemetry";
import { parseArgs } from "../src/main";
import type { SuiteRunner, Options } from "../src/common";
async function invoke(suite: Parameters<typeof loadCorpus>[0], runner: SuiteRunner, id: string) {
  const row = (await loadCorpus(suite)).find((r) => r.case_id === id)!;
  const t = new Telemetry();
  try {
    return await t.span("CHAIN", id, row.input, undefined, (span) =>
      runner(row, { live: false, backend: "fixture", agent: "mock", runId: "test", span, telemetry: t }),
    );
  } finally {
    await t.provider.shutdown();
  }
}
test("CLI fails closed on network opt-in and unknown options", () => {
  expect(parseArgs(["run", "--suite", "all"]).live).toBe(false);
  expect(() => parseArgs(["run", "--backend", "typesafe"])).toThrow();
  expect(() => parseArgs(["run", "--limit", "0"])).toThrow();
  expect(() => parseArgs(["run", "--foo"])).toThrow();
});
test("Offline triage is explicitly a scripted identity; parser does not pretend to decide", async () => {
  const r = await invoke("triage", runTriage, "triage-cart-empty-1");
  expect(r.identity).toBe("fixture/oracle-v1 + parser/regex");
  expect(r.scores.duplicate?.score).toBe(1);
});
test("Injection eval requires escaped boundaries and redaction without leaking canary in saved output", async () => {
  const r = await invoke("injection", runInjection, "injection-04");
  expect(r.scores.agent_wrapping?.score).toBe(1);
  expect(r.scores.triage_wrapping?.score).toBe(1);
  expect(r.scores.extraction_wrapping?.score).toBe(1);
  expect(r.scores.harness_redaction?.score).toBe(1);
  expect(r.scores.explicit_redaction?.score).toBe(1);
  expect(JSON.stringify(r.output)).not.toContain("EPHYRA_EVAL_CANARY_9381");
});
test("Actual offline mock loop produces executable before/after proof with no invented sessions", async () => {
  const r = await invoke("agent", runAgent, "agent-sum");
  expect(r.scores.completion?.score).toBe(1);
  expect(r.scores.allowed_paths?.score).toBe(1);
  expect((r.output as any).stepCount).toBe(4);
}, 15000);
test("Recorded Amp authentication error is unavailable and correctly classified", async () => {
  const r = await invoke("agent", runAgent, "agent-amp-reauth");
  expect(r.status).toBe("unavailable");
  expect(r.reason).toContain("reauthenticate");
  expect((r.output as any).classificationCorrect).toBe(true);
  expect(r.scores.completion?.score).toBeNull();
});
test("Repro must fail at base; missing probe is unverified, not proof", async () => {
  for (const id of ["proof-base-passes", "proof-unavailable-probe"]) {
    const r = await invoke("proof", runProof, id);
    expect(r.scores.safe?.score).toBe(1);
    expect((r.output as any).verdict).toBe("unverified");
  }
}, 15000);
test("a real flaky probe is refused for its repeat disagreement", async () => {
  const r = await invoke("proof", runProof, "proof-flaky-reruns");
  expect(r.scores.safe?.score).toBe(1);
  expect(r.output).toMatchObject({ verdict: "unverified" });
  expect((r.output as { reason: string }).reason).toContain("flaky probe");
}, 15000);
test("Feedback tests reach stale binding and failure paths in actual server wiring", async () => {
  for (const id of [
    "feedback-stale-head",
    "feedback-agent-timeout",
    "feedback-agent-false",
    "feedback-reconciliation",
  ])
    expect((await invoke("feedback", runFeedback, id)).scores.safe?.score).toBe(1);
}, 15000);
test("Local deadline kills the whole command group, including pipe-holding descendants", async () => {
  const { command } = await import("../src/local");
  const { APP } = await import("../src/data");
  const start = Date.now();
  const result = await command(APP, ["sh", "-c", "rtk proxy sleep 30 & wait"], 80);
  expect(result.timedOut).toBe(true);
  expect(Date.now() - start).toBeLessThan(3000);
}, 4000);

test("Observed semantic failures are distinct from unavailable/authentication and deadlines", () => {
  expect(measuredContractFailure("patch produced no commits", 3)).toBe(true);
  expect(measuredContractFailure("patch produced no commits", 0)).toBe(false);
  expect(measuredContractFailure("agent authentication failed", 3)).toBe(false);
  expect(measuredContractFailure("command deadline exceeded", 3)).toBe(false);
});
