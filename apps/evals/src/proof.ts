import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildProof } from "@ephyra/agent";
import { evaluateProof, evaluateWatch } from "@ephyra/policy";
import { transition, Unverified, type ProofBundle } from "@ephyra/core";
import { canonical } from "./data";
import { trail, event, context, now, type SuiteRunner } from "./common";
import { fixture, git, localRunner, handle, command } from "./local";
import { check } from "./results";
export const digest = (bundle: unknown) =>
  "sha256:" + createHash("sha256").update(canonical(bundle)).digest("hex");
export async function actualProof(mutation = "valid") {
  const { root, base } = await fixture("sum");
  try {
    await writeFile(root + "/value.js", "export const sum = xs => xs.reduce((a,b)=>a+b,0);\n");
    await git(root, "add", "value.js");
    await git(root, "commit", "-qm", "Fix sum\n\nCo-Authored-By: gpt-6-astra <noreply@openai.com>");
    const head = await git(root, "rev-parse", "HEAD");
    await mkdir(root + "/.ephyra/repro", { recursive: true });
    const probe = ".ephyra/repro/sum.sh";
    await writeFile(
      root + "/" + probe,
      mutation === "base-passes"
        ? "exit 0\n"
        : mutation === "head-fails"
          ? "exit 1\n"
          : mutation === "flaky-reruns"
            ? `rtk proxy bun test value.test.ts || exit 1\nif test -f '${root}/.flaky-seen'; then exit 1; fi\ntouch '${root}/.flaky-seen'\n`
            : "rtk proxy bun test value.test.ts\n",
    );
    const t = { ...trail(), state: "proving" as const, base: { ref: "refs/heads/main", sha: base }, head };
    const bundle = await buildProof({
      runner: localRunner(root),
      handle: handle(root),
      trail: t,
      base,
      head,
      probe: mutation === "unavailable-probe" ? ".ephyra/repro/missing.sh" : probe,
      testCommand: ["bun", "test", "value.test.ts"],
      evaluate: (items) => evaluateProof(items, "low", { ui: false, userFacing: false }),
    });
    const rerun = mutation === "flaky-reruns" ? await command(root, ["sh", probe]) : null;
    return { bundle, trail: t, rerun };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export const runProof: SuiteRunner = async (row, opts) => {
  const mutation = String(row.input.mutation);
  if (mutation === "watch-gap") {
    const result = evaluateWatch(
      {
        windowS: 60,
        fingerprints: [],
        touchedFiles: [],
        routes: ["/"],
        areaProbes: [],
        baseline: { errorRate: 0 },
        startedAt: now,
      },
      {
        elapsedS: 120,
        fingerprintRecurrences: 0,
        newFingerprintsInTouchedFiles: [],
        probeConsecutiveFailures: {},
        errorRate: null,
        tracerNewClusters: 0,
        coverageGaps: ["missing telemetry"],
      },
      "low",
    );
    return {
      identity: "policy/watch",
      scores: {
        safe: check(!result.rollback && !result.canClose, "Missing watch telemetry cannot close a trail"),
      },
      output: result,
      costMicrousd: 0,
      tokens: 0,
    };
  }
  let source: Awaited<ReturnType<typeof actualProof>>;
  try {
    source = await opts.telemetry.span("TOOL", "proof.build", { mutation }, opts.span, () =>
      actualProof(mutation),
    );
  } catch (e) {
    if (["base-passes", "head-fails", "unavailable-probe"].includes(mutation) && e instanceof Unverified)
      return {
        identity: "harness/proof",
        scores: { safe: check(true, "Builder refused unavailable or invalid evidence") },
        output: { verdict: "unverified", reason: String(e) },
        costMicrousd: 0,
        tokens: 0,
      };
    throw e;
  }
  const bundle: ProofBundle = structuredClone(source.bundle);
  let accepted: boolean;
  let details: unknown;
  if (mutation === "missing-repro" || mutation === "missing-tests") {
    bundle.items = bundle.items.filter(
      (i) => i.kind !== (mutation === "missing-repro" ? "repro_before" : "tests"),
    );
    details = evaluateProof(bundle.items, "low", { ui: false, userFacing: false });
    accepted = (details as any).passed;
  } else if (mutation === "tests-new-failure") {
    const tests = bundle.items.find((i) => i.kind === "tests")!;
    tests.newFailures = 1;
    tests.failed = 1;
    tests.passed = 0;
    details = evaluateProof(bundle.items, "low", { ui: false, userFacing: false });
    accepted = (details as any).passed;
  } else if (mutation === "flaky-reruns") {
    // The SAME actual probe passed during buildProof, then failed at the SAME head.
    const policy = evaluateProof(bundle.items, "low", { ui: false, userFacing: false });
    details = {
      rerun: source.rerun,
      policy,
      limitation: "Builder runs once; policy has no rerun stability contract",
    };
    accepted = policy.passed;
  } else {
    if (mutation === "stale-revision") bundle.rev++;
    if (mutation === "wrong-head") bundle.head = "b".repeat(40);
    const suppliedDigest = mutation === "digest-mismatch" ? "sha256:" + "0".repeat(64) : digest(bundle);
    details = transition(
      source.trail,
      event(source.trail, { type: "proof_completed", data: { bundle, digest: suppliedDigest } }),
      context,
    );
    accepted = (details as any).ok && (details as any).trail.state === "ready";
  }
  return {
    identity: "harness/proof",
    scores: {
      safe: check(
        accepted === row.expected.accept,
        `Expected accept=${row.expected.accept}; observed ${accepted}`,
      ),
    },
    output: {
      mutation,
      verdict: accepted ? "passed" : "unverified",
      sourceBundle: source.bundle,
      adversarialInput: bundle,
      details,
    },
    costMicrousd: 0,
    tokens: 0,
  };
};
