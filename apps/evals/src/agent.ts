import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import {
  buildProof,
  MockAgent,
  ClaudeCodeAgent,
  CodexAgent,
  AmpAgent,
  MemoryAmpThreads,
  parseAmpStream,
  renderPrompt,
} from "@ephyra/agent";
import { transition, Unverified, type AgentResult, type AgentStep } from "@ephyra/core";
import { evaluateProof } from "@ephyra/policy";
import { APP } from "./data";
import { trail, event, context, now, type SuiteRunner, type Outcome } from "./common";
import { fixture, git, localRunner, handle } from "./local";
import { check, unscored } from "./results";
import { clean } from "./telemetry";
export function measuredContractFailure(reason: string, completedSteps: number): boolean {
  return (
    completedSteps > 0 &&
    /patch produced no commits|patch trail trailer|repro artefact|probe outcome/.test(reason)
  );
}
export const runAgent: SuiteRunner = async (row, opts): Promise<Outcome> => {
  if (row.input.recorded) {
    const parsed = parseAmpStream(
      await readFile(APP + "../../packages/agent/test/fixtures/amp-error-reauth.jsonl", "utf8"),
    );
    return {
      identity: "amp/recorded-reauth",
      status: "unavailable",
      reason: parsed.error,
      scores: { completion: unscored(parsed.error ?? "Amp failed") },
      output: {
        replayed: true,
        classificationCorrect: !parsed.ok && Boolean(parsed.error?.includes("reauthenticate")),
        parsed,
      },
      tokens: null,
      costMicrousd: null,
    };
  }
  const { root, base } = await fixture(String(row.input.fixture));
  const h = handle(root);
  const live = opts.live;
  const model =
    process.env.EPHYRA_AGENT_MODEL ?? (opts.agent === "claude-code" ? "claude-opus-5-5" : "gpt-6.1-sol");
  const identity = live ? `${opts.agent}/${model}` : "mock/script-v1";
  let t = trail();
  t.base.sha = base;
  const steps: unknown[] = [];
  const usages: AgentResult["usage"][] = [];
  const artefacts: Record<string, string> = {};
  try {
    const liveAgent =
      opts.agent === "claude-code"
        ? new ClaudeCodeAgent(model)
        : opts.agent === "codex"
          ? new CodexAgent(model)
          : opts.agent === "amp"
            ? new AmpAgent({ executor: { kind: "local" }, threads: new MemoryAmpThreads(), mode: "low" })
            : null;
    if (live && !liveAgent) throw new Unverified(`unknown live agent ${opts.agent}`);
    let head = base,
      probe = "";
    for (const step of ["research", "repro", "plan", "patch"] as AgentStep[]) {
      const task = {
        step,
        trail: t,
        context: {
          scope:
            "Only this tiny repository. Never change tests. Allowed: value.js, hypothesis.md, plan.md, " +
            ".ephyra/repro/*.sh. Run rtk proxy bun test value.test.ts. Keep work brief; no plugins, network, " +
            "subagents, pushes or remotes.",
          budget:
            "At most 8 tool turns and 6000 tokens per step. Commit using Ephyra-Trail and Co-Authored-By trailers.",
        },
        untrusted: { signal: String(row.input.bug), prior_artifacts: JSON.stringify(artefacts) },
        budget: { tokens: 6000, wallclockS: 120 },
      };
      const started = Date.now();
      const startHead = await git(root, "rev-parse", "HEAD");
      const result = await opts.telemetry.span(
        "AGENT",
        `agent.${step}`,
        { prompt: renderPrompt(task) },
        opts.span,
        async (span) => {
          const runner = localRunner(root, opts.telemetry, span);
          let result: AgentResult;
          if (live) result = await liveAgent!.run(task, runner, h);
          else {
            const files: Record<string, string> = {};
            const outputs: Record<string, string> = {};
            if (step === "research")
              files["hypothesis.md"] =
                "Fixture-script hypothesis: the seeded expression mishandles the boundary in value.js. Verify with " +
                "value.test.ts; no production evidence claimed.";
            if (step === "plan")
              files["plan.md"] =
                "Change only value.js; preserve value.test.ts. Run the same probe at base and head. This is a scripted offline plan, not model reasoning.";
            if (step === "repro") {
              outputs.probe = ".ephyra/repro/seed.sh";
              files[outputs.probe] = "rtk proxy bun test value.test.ts\n";
            }
            for (const [path, text] of Object.entries(files)) {
              await mkdir(root + "/" + path.split("/").slice(0, -1).join("/"), { recursive: true });
              await writeFile(root + "/" + path, text);
            }
            if (step === "patch") {
              await writeFile(root + "/value.js", String(row.expected.fixed_source));
              await git(root, "add", "value.js");
              await git(
                root,
                "commit",
                "-qm",
                `Fix fixture\n\nEphyra-Trail: ${t.id}\nCo-Authored-By: gpt-6-astra <noreply@openai.com>`,
              );
              outputs.head = await git(root, "rev-parse", "HEAD");
            }
            result = await new MockAgent([
              {
                ok: true,
                artefacts: files,
                outputs,
                usage: { tokens: 0, costMicrousd: 0, model: "mock/script-v1" },
                sessions: [],
              },
            ]).run();
          }
          span.setAttributes({
            "ephyra.agent": identity,
            "llm.model_name": result.usage.model,
            "llm.token_count.total": result.usage.tokens,
            "output.value": clean(result),
          });
          if (result.usage.costMicrousd !== null)
            span.setAttribute("llm.cost.total", result.usage.costMicrousd / 1e6);
          return result;
        },
      );
      usages.push(result.usage);
      steps.push({
        step,
        wallMs: Date.now() - started,
        startHead,
        endHead: await git(root, "rev-parse", "HEAD"),
        result,
      });
      if (!result.ok) throw new Unverified(result.error ?? "agent returned ok=false");
      Object.assign(artefacts, result.artefacts);
      if (step === "repro") probe = result.outputs.probe ?? "";
      if (step === "patch") head = result.outputs.head ?? "";
      const body =
        step === "research"
          ? { type: "research_completed" as const, data: { hypothesis: "hypothesis.md" } }
          : step === "repro"
            ? { type: "repro_completed" as const, data: { ok: true, probe } }
            : step === "plan"
              ? { type: "plan_completed" as const, data: { plan: "plan.md" } }
              : { type: "patch_completed" as const, data: { head, revision: 2 } };
      const tr = transition(t, event(t, body), context);
      if (!tr.ok) throw new Error(tr.error);
      t = tr.trail;
      if (step === "research" || step === "plan") {
        const approve = transition(
          t,
          event(t, {
            type: "checkpoint_decided",
            data: {
              checkpoint: step === "research" ? "A" : "B",
              decision: {
                by: "human",
                who: "offline-eval-driver",
                at: now,
                verdict: "approve",
                note: "Synthetic checkpoint for disposable test fixture only",
              },
            },
          }),
          context,
        );
        if (!approve.ok) throw new Error(approve.error);
        t = approve.trail;
      }
    }
    const bundle = await opts.telemetry.span(
      "TOOL",
      "proof.build",
      { base, head, probe },
      opts.span,
      (span) =>
        buildProof({
          runner: localRunner(root, opts.telemetry, span),
          handle: h,
          trail: t,
          base,
          head,
          probe,
          testCommand: ["bun", "test", "value.test.ts"],
          evaluate: (items) => evaluateProof(items, "low", { ui: false, userFacing: false }),
        }),
    );
    const changed = (await git(root, "diff", "--name-only", base, head)).split("\n").filter(Boolean);
    const allowed = row.input.allowed_paths as string[];
    const pathsOk = changed.every((p) => allowed.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a)));
    return {
      identity,
      scores: {
        completion: check(bundle.passed, "Full research, repro, plan, patch, executable proof"),
        repro: check(
          bundle.items.some((i) => i.kind === "repro_before") &&
            bundle.items.some((i) => i.kind === "repro_after"),
          "Same probe actually fails at base and passes at head",
        ),
        allowed_paths: check(pathsOk, changed.join(", ")),
        plan_quality: unscored("Qualitative rubric committed; no judge called"),
        explanation_quality: unscored("Qualitative rubric committed; no judge called"),
      },
      output: {
        steps,
        bundle,
        changed,
        stepCount: steps.length,
        artefacts,
        usageIdentityProvenance: live
          ? "CLI adapter echoes requested model; provider-resolved identity not exposed"
          : "scripted offline fixture",
      },
      tokens: usages.reduce((n, u) => n + u.tokens, 0),
      costMicrousd: usages.every((u) => u.costMicrousd !== null)
        ? usages.reduce((n, u) => n + u.costMicrousd!, 0)
        : null,
    };
  } catch (e) {
    // Completed provider turns followed by a semantic contract failure are measured failures.
    // Authentication, absent usage, deadlines and ambiguous CLI failures remain unavailable.
    const contractFailure = measuredContractFailure(String(e), usages.length);
    return {
      identity,
      status: contractFailure ? "scored" : "unavailable",
      reason: clean(String(e)),
      scores: { completion: contractFailure ? check(false, clean(String(e))) : unscored(clean(String(e))) },
      output: {
        steps,
        stepCount: steps.length,
        artefacts,
        reason: clean(String(e)),
        diagnostics: opts.telemetry.memory
          .getFinishedSpans()
          .filter((s) => ["claude", "codex", "amp"].includes(String(s.attributes["tool.name"])))
          .map((s) => s.attributes["output.value"]),
      },
      tokens: usages.length ? usages.reduce((n, u) => n + u.tokens, 0) : null,
      costMicrousd:
        usages.length && usages.every((u) => u.costMicrousd !== null)
          ? usages.reduce((n, u) => n + u.costMicrousd!, 0)
          : null,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
