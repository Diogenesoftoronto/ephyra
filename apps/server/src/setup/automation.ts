import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { BootstrapCoverage, BootstrapReport, BootstrapResponse, SetupRun, type SetupMode } from "@ephyra/core";
import { parseAutonomy, parseThresholds, renderAutonomy, THRESHOLDS_TEMPLATE } from "@ephyra/policy";
import { redact } from "@ephyra/agent";
import type { Git } from "../wiring/landing.ts";
import type { Jobs, RepoConfig } from "../wiring/context.ts";
import { redactModelText } from "./model-redaction.ts";
import { assessBootstrap, bootstrapDigest, inspectBootstrapSources } from "./bootstrap.ts";

const CURRENT = "refs/ephyra/setup/current";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const identity = { GIT_AUTHOR_NAME: "Ephyra", GIT_AUTHOR_EMAIL: "setup@ephyra.invalid",
  GIT_COMMITTER_NAME: "Ephyra", GIT_COMMITTER_EMAIL: "setup@ephyra.invalid" };
export class SetupConflict extends Error {}
export type SetupCapability = { id: string; available: boolean; summary: string; action: string };
export type SetupOptions = {
  git: Git; repo: RepoConfig; jobs: Jobs;
  capabilities: (run?: SetupRun) => Promise<SetupCapability[]>;
  activate: (run: SetupRun) => Promise<void>;
  /** Observations from current workspace authority. Configuration and observed evidence remain distinct. */
  assess?: (run: SetupRun) => Promise<BootstrapCoverage[]>;
  /** Queue owner contact only after the assessment is durable; this hook must not send external messages. */
  onAssessed?: (run: SetupRun) => Promise<void>;
  reassessEveryMs?: number;
  provision?: (run: SetupRun) => Promise<{
    artifacts: SetupRun["artifacts"]; verification: boolean; provisioned: boolean; detail: string;
  }>;
  secrets?: string[];
  now?: () => Date;
};

/** No host Git configuration, hooks, external diff, filters or ambient credentials. */
export function setupGit(directory: string): Git {
  return (args, options) => new Promise((resolve, reject) => {
    const child = spawn("git", ["--git-dir", directory, "-c", "core.hooksPath=/dev/null", ...args], {
      env: { PATH: process.env.PATH, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", ...identity, ...options?.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let size = 0;
    let failed = false;
    const fail = () => { failed = true; child.kill("SIGKILL"); };
    const timeout = setTimeout(fail, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2_000_000) fail();
      else output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 2_000_000) fail(); });
    child.on("error", () => { clearTimeout(timeout); reject(new Error("Setup Git operation unavailable.")); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || failed) reject(new Error("Setup Git operation failed or exceeded its limits."));
      else resolve(output);
    });
    child.stdin.on("error", () => { /* close reports the failure without logging input */ });
    child.stdin.end(options?.input ?? "");
  });
}

const steps = () => [
  { id: "inspect", name: "Inspect repository", status: "pending" as const, detail: "Read the connected commit and build configuration." },
  { id: "policy", name: "Prepare autonomy policy", status: "pending" as const, detail: "Set machine checkpoints or optional human review." },
  { id: "proof", name: "Prepare verification", status: "pending" as const, detail: "Discover test commands and baseline requirements." },
  { id: "evidence", name: "Map evidence sources", status: "pending" as const, detail: "Identify telemetry and investigation connections." },
  { id: "activate", name: "Check execution readiness", status: "pending" as const, detail: "Check the capabilities the loop needs." },
];

/** Generate a starting policy from observed paths; do not invent product intent or successful checks. */
export function bootstrapArtifacts(files: string[], manifest: unknown, mode: SetupMode): SetupRun["artifacts"] {
  const human = mode === "supervised";
  const manifestObject = manifest && typeof manifest === "object" ? manifest as Record<string, unknown> : {};
  const scripts = manifestObject.scripts && typeof manifestObject.scripts === "object"
    ? Object.entries(manifestObject.scripts).filter(([key, value]) => /^(test|build|typecheck|lint)(:.*)?$/.test(key)
      && typeof value === "string" && value.length < 2000).map(([name, command]) => ({ name, command })) : [];
  const checkpoints = human ? "A=blocking B=blocking C=blocking" : "A=advisory B=advisory C=advisory";
  const policy = `# Autonomy policy\n\n## defaults\nmode: enforce\ncheckpoints: ${checkpoints}\n`
    + `landing: ${human ? "trail_ref" : "auto_land"}\nwatch: 2h\ndecide: judgement\n\n`
    + "## area: application\npaths: **\nrisk: medium\nuser_facing: true\n"
    + "Investigate evidence, test competing explanations, reproduce, patch, prove and watch the result.\n"
    + "Record questions, source coverage, decisions, costs and unsuccessful approaches.\n"
    + "Ask a specific person only when their information or authority can unblock progress.\n"
    + "A fresh context must retain the objective, prior attempts, evidence, permissions and remaining budget.\n"
    + "Repository commands are candidates, never proof that a check ran. Missing evidence cannot pass.\n\n"
    + "## area: automation-control\npaths: ephyra/**, autonomy.md, thresholds.yaml\nrisk: critical\nuser_facing: false\n"
    + "checkpoints: C=blocking\n"
    + "The loop cannot expand its own authority, budget or verification rules.\n";
  parseAutonomy(policy);
  const integrations = [
    { name: "PostHog", discovered: files.some((f) => /posthog/i.test(f)), status: "unverified" },
    { name: "OpenTelemetry", discovered: files.some((f) => /otel|opentelemetry/i.test(f)), status: "unverified" },
    { name: "Traction", discovered: files.some((f) => /traction/i.test(f)), status: "unverified" },
  ];
  const artifacts: Record<string, string> = {
    "autonomy.md": policy,
    "thresholds.yaml": THRESHOLDS_TEMPLATE,
    "ephyra/verification.json": JSON.stringify({ schema: 1, status: "not_run", commands: scripts,
      required: ["repro_before", "repro_after", "tests", "diff_scope", "regression_probes", "intent_probes", "bug_review"],
      note: "Run commands in the workspace sandbox, verify baseline failures, and retain receipts before enabling landing." }, null, 2),
    "ephyra/evidence.json": JSON.stringify({ schema: 1, sources: integrations,
      note: "Detected filenames are hints only. Verify source credentials, project scope, coverage and freshness." }, null, 2),
    "intents/application.md": "# Application intent\n\nProduct intent has not yet been verified.\n"
      + "Use repository documentation and observed behavior to form hypotheses; seek targeted user input for unresolved intent.\n"
      + "Attach source references and executable probes before treating an interpretation as a requirement.\n",
    "ephyra/recovery.json": JSON.stringify({ schema: 1, status: "configuration",
      maxAttempts: 3, strategies: ["fresh_context", "alternate_hypothesis", "additional_evidence", "targeted_question"],
      preserve: ["objective", "evidence", "failed_attempts", "authorization", "remaining_budget", "operation_receipts"],
      note: "Do not replay an ambiguous external write or reset budgets when starting a fresh context." }, null, 2),
  };
  return Object.entries(artifacts).map(([path, content]) => ({ path, content, digest: sha(content) }));
}

/** The Git ref is the durable setup record; the queue is replaceable. Every stage is local and safely resumable. */
export class AutomaticSetup {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: SetupOptions) {
    if (options.reassessEveryMs !== undefined && (!Number.isSafeInteger(options.reassessEveryMs)
      || options.reassessEveryMs < 10_000 || options.reassessEveryMs > 24 * 3600_000))
      throw new Error("Invalid bootstrap reassessment interval.");
    options.jobs.register("automatic_setup", async (payload) => {
      const { id } = payload as { id: string };
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid setup run.");
      await this.serial(() => this.execute(id));
    });
    options.jobs.register("bootstrap_reassess", async (payload) => {
      const value = payload as { id?: string; head?: string; notBefore?: string };
      if (!value.id || !value.head || !value.notBefore || !Number.isFinite(Date.parse(value.notBefore)))
        throw new Error("Invalid bootstrap reassessment.");
      if (Date.parse(this.time()) < Date.parse(value.notBefore)) return;
      await this.serial(async () => {
        const current = await this.read(CURRENT);
        if (!current || current.run.id !== value.id || current.run.repository.head !== value.head) return;
        await this.refresh(current);
      });
    });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(work);
    this.chain = next;
    return next;
  }
  private time() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private nextAssessment() {
    const interval = this.options.reassessEveryMs ?? 5 * 60_000;
    return new Date((Math.floor(Date.parse(this.time()) / interval) + 1) * interval).toISOString();
  }
  private ref(id: string) { return `refs/ephyra/setup/runs/${id}`; }
  private async head(ref: string): Promise<string | null> {
    try { return (await this.options.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`])).trim(); }
    catch { return null; }
  }
  private async read(ref: string): Promise<{ head: string; run: SetupRun } | null> {
    const head = await this.head(ref);
    if (!head) return null;
    return { head, run: SetupRun.parse(JSON.parse(await this.options.git(["show", `${head}:state.json`]))) };
  }
  async current(operationKey?: string): Promise<SetupRun | null> {
    const ref = operationKey ? this.ref(sha(operationKey).slice(0, 32)) : CURRENT;
    return (await this.read(ref))?.run ?? null;
  }
  /** Historical snapshots remain readable for reconciling an interrupted answer; they cannot accept new answers. */
  async record(id: string): Promise<SetupRun | null> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new SetupConflict("Invalid setup record.");
    return (await this.read(this.ref(id)))?.run ?? null;
  }
  private async save(run: SetupRun, expected: string | null, currentExpected: string | null): Promise<string> {
    run.updatedAt = this.time();
    const paths = [{ path: "state.json", content: JSON.stringify(run) }, ...run.artifacts];
    const makeTree = async (entries: typeof paths): Promise<string> => {
      const rows: string[] = [];
      const directories = new Map<string, typeof paths>();
      for (const entry of entries) {
        if (!/^[a-z0-9._/-]+$/.test(entry.path) || entry.path.split("/").some((part) => !part || part === ".."))
          throw new Error("Invalid setup artifact path.");
        const slash = entry.path.indexOf("/");
        if (slash >= 0) {
          const name = entry.path.slice(0, slash);
          const nested = directories.get(name) ?? [];
          nested.push({ path: entry.path.slice(slash + 1), content: entry.content });
          directories.set(name, nested);
        } else {
          const blob = (await this.options.git(["hash-object", "-w", "--stdin"], { input: entry.content })).trim();
          rows.push(`100644 blob ${blob}\t${entry.path}\n`);
        }
      }
      for (const [name, nested] of directories) rows.push(`040000 tree ${await makeTree(nested)}\t${name}\n`);
      return (await this.options.git(["mktree"], { input: rows.join("") })).trim();
    };
    const tree = await makeTree(paths);
    const commit = (await this.options.git(["commit-tree", tree, ...(expected ? ["-p", expected] : []), "-F", "-"], {
      input: `Ephyra automatic setup: ${run.id} ${run.status}\n`, env: identity,
    })).trim();
    const zero = "0".repeat(commit.length);
    await this.options.git(["update-ref", "--stdin"], {
      input: `start\nupdate ${this.ref(run.id)} ${commit} ${expected ?? zero}\n`
        + `update ${CURRENT} ${commit} ${currentExpected ?? zero}\nprepare\ncommit\n`,
    });
    return commit;
  }
  async start(mode: SetupMode, operationKey: string): Promise<SetupRun> {
    if (!/^[A-Za-z0-9:._-]{8,160}$/.test(operationKey)) throw new SetupConflict("A valid operation key is required.");
    return this.serial(async () => {
      const prior = await this.current(operationKey);
      if (prior) {
        if (prior.mode !== mode) throw new SetupConflict("This operation key belongs to another setup mode.");
        return prior;
      }
      const current = await this.read(CURRENT);
      if (current && ["queued", "running"].includes(current.run.status))
        throw new SetupConflict("Setup is already running. Follow its progress.");
      if (!this.options.repo.url) throw new SetupConflict("Connect a repository before starting automatic setup.");
      const head = await this.head(this.options.repo.baseRef);
      if (!head) throw new SetupConflict("The connected repository commit is unavailable.");
      const id = sha(operationKey).slice(0, 32);
      const run: SetupRun = { id, operationKey, mode, status: "queued", startedAt: this.time(), updatedAt: this.time(),
        repository: { url: this.options.repo.url, branch: this.options.repo.baseRef.replace(/^refs\/heads\//, ""), head },
        steps: steps(), artifacts: [], blockers: [], policyRef: this.ref(id),
      };
      await this.save(run, null, current?.head ?? null);
      await this.options.jobs.enqueue("automatic_setup", `setup:${id}`, { id });
      return run;
    });
  }
  async restore(): Promise<void> {
    await this.serial(async () => {
      const current = await this.read(CURRENT);
      if (!current) return;
      if (["queued", "running"].includes(current.run.status))
        await this.options.jobs.enqueue("automatic_setup", `setup:${current.run.id}:restore:${current.head}`, { id: current.run.id });
      else await this.refresh(current, true);
    });
  }
  /** Cheap coverage/settings reassessment. Never provisions a runner or invokes a model. */
  async reassess(): Promise<SetupRun | null> {
    return this.serial(async () => {
      const current = await this.read(CURRENT);
      return current ? this.refresh(current) : null;
    });
  }
  private async assess(run: SetupRun, capabilities: SetupCapability[]) {
    let extra: BootstrapCoverage[] = [];
    try { extra = await this.options.assess?.(run) ?? []; }
    catch { /* Failed observations remain unknown; provider errors never become context or proof. */ }
    extra = (Array.isArray(extra) ? extra : []).flatMap((value) => {
      const parsed = BootstrapCoverage.safeParse(value);
      if (!parsed.success) return [];
      const item = parsed.data;
      return [{ ...item, summary: redact(item.summary, this.options.secrets ?? [], 2000).slice(0, 2000),
        references: item.references.filter((reference) => redact(reference, this.options.secrets ?? [], 2048) === reference) }];
    });
    run.bootstrap = assessBootstrap(run, capabilities, extra, this.time(), this.nextAssessment());
    const content = JSON.stringify(run.bootstrap, null, 2);
    run.artifacts = run.artifacts.filter((artifact) => artifact.path !== "ephyra/bootstrap.json");
    run.artifacts.push({ path: "ephyra/bootstrap.json", content, digest: sha(content) });
  }
  private async schedule(run: SetupRun) {
    if (!run.bootstrap || !["ready", "blocked"].includes(run.status)) return;
    const at = run.bootstrap.nextAssessmentAt;
    const key = bootstrapDigest([run.id, run.repository.head, at]);
    await this.options.jobs.enqueue("bootstrap_reassess", `bootstrap:${key}`, {
      id: run.id, head: run.repository.head, notBefore: at,
    }, { runAt: new Date(at) });
  }
  private async assessed(run: SetupRun) {
    try { await this.options.onAssessed?.(structuredClone(run)); }
    catch { /* Owner requests are already durable. A later assessment can retry scheduling, never an external delivery. */ }
  }
  private async readiness(run: SetupRun, capabilities: SetupCapability[]) {
    run.blockers = capabilities.filter((cap) => !cap.available)
      .map(({ id, summary, action }) => ({ id, summary, action, owner: "operator" }));
    if (await this.head(this.options.repo.baseRef) !== run.repository.head)
      run.blockers.push({ id: "base_changed", summary: "The repository changed since this setup snapshot.",
        action: "Run setup again against the current commit.", owner: "maintainer" });
    run.status = run.blockers.length ? "blocked" : "ready";
    const hard = new Set(["agent", "runner", "decision", "verification", "base_changed"]);
    run.investigationActive = !run.blockers.some((blocker) => hard.has(blocker.id));
    run.steps[4]!.status = run.blockers.length ? "blocked" : "complete";
    run.steps[4]!.detail = run.blockers.length
      ? run.investigationActive ? "Investigation is active. The listed capabilities still block unattended landing."
        : "Configuration is prepared. Resolve the listed capabilities before activating the loop."
      : "Required capabilities are configured. This is not proof of a production repair.";
  }
  private async refresh(current: { head: string; run: SetupRun }, reactivate = false): Promise<SetupRun> {
    const { run } = current;
    if (!["ready", "blocked"].includes(run.status)) return run;
    if (!run.bootstrap) {
      const files = (await this.options.git(["ls-tree", "-r", "-z", "--name-only", run.repository.head])).split("\0").filter(Boolean);
      run.bootstrap = { schema: 1, setupId: run.id, head: run.repository.head, assessedAt: this.time(),
        nextAssessmentAt: this.nextAssessment(), sources: await inspectBootstrapSources(
          this.options.git, run.repository.head, files, this.options.secrets), coverage: [], requests: [], contextReports: [] };
    }
    const wasActive = run.status === "ready" || run.investigationActive;
    const capabilities = await this.options.capabilities(run);
    await this.readiness(run, capabilities);
    await this.assess(run, capabilities);
    await this.save(run, current.head, current.head);
    await this.schedule(run);
    await this.assessed(run);
    if ((run.status === "ready" || run.investigationActive) && (reactivate || !wasActive)) await this.options.activate(run);
    return run;
  }
  private async bound(setupId: string, head: string) {
    const current = await this.read(CURRENT);
    if (!current || !current.run.bootstrap || current.run.id !== setupId || current.run.repository.head !== head
      || await this.head(this.options.repo.baseRef) !== head || !["ready", "blocked"].includes(current.run.status))
      throw new SetupConflict("This setup snapshot changed. Refresh the current repository assessment.");
    return current;
  }
  private actor(actor: { id: string; kind: "human" | "agent" }, operationKey: string) {
    if (!actor.id || actor.id.length > 300 || !["human", "agent"].includes(actor.kind)) throw new SetupConflict("A verified actor is required.");
    if (!/^[A-Za-z0-9:._-]{8,160}$/.test(operationKey)) throw new SetupConflict("A valid operation key is required.");
  }
  async respond(input: BootstrapResponse, actor: { id: string; kind: "human" | "agent" }, operationKey: string): Promise<SetupRun> {
    const value = BootstrapResponse.parse(input);
    this.actor(actor, operationKey);
    return this.serial(async () => {
      const current = await this.bound(value.setupId, value.head);
      const request = current.run.bootstrap!.requests.find((item) => item.id === value.requestId);
      if (!request || request.kind !== "context" || request.status === "resolved")
        throw new SetupConflict("This request needs a verified configuration change, not an answer.");
      const digest = bootstrapDigest([value, actor.id, actor.kind]);
      if (request.answer) {
        if (request.answer.operationKey === operationKey && request.answer.digest === digest) return current.run;
        throw new SetupConflict("This request already has an attributed response. Refresh before continuing.");
      }
      if (current.run.bootstrap!.contextReports.some((report) => report.operationKey === operationKey))
        throw new SetupConflict("This operation key belongs to another bootstrap response.");
      if (current.run.bootstrap!.requests.some((item) => item.answer?.operationKey === operationKey))
        throw new SetupConflict("This operation key belongs to another bootstrap response.");
      request.answer = { text: redact(value.text, this.options.secrets ?? [], 4000).slice(0, 4000), by: actor.id, kind: actor.kind,
        at: this.time(), operationKey, digest };
      request.status = "answered";
      request.updatedAt = this.time();
      await this.assess(current.run, await this.options.capabilities(current.run));
      await this.save(current.run, current.head, current.head);
      await this.assessed(current.run);
      return current.run;
    });
  }
  async report(input: BootstrapReport, actor: { id: string; kind: "human" | "agent" }, operationKey: string): Promise<SetupRun> {
    const value = BootstrapReport.parse(input);
    this.actor(actor, operationKey);
    return this.serial(async () => {
      const current = await this.bound(value.setupId, value.head);
      const assessment = current.run.bootstrap!;
      const digest = bootstrapDigest([value, actor.id, actor.kind]);
      const prior = assessment.contextReports.find((report) => report.operationKey === operationKey);
      if (prior) {
        if (prior.digest !== digest) throw new SetupConflict("This operation key belongs to a different bootstrap report.");
        return current.run;
      }
      if (assessment.requests.some((request) => request.answer?.operationKey === operationKey))
        throw new SetupConflict("This operation key belongs to another bootstrap response.");
      if (assessment.contextReports.length >= 20) throw new SetupConflict("This assessment has reached its bounded context report limit.");
      const clean = (text: string, max: number) => redact(text, this.options.secrets ?? [], max).slice(0, max);
      assessment.contextReports.push({ id: bootstrapDigest([current.run.id, operationKey]), operationKey, digest,
        by: actor.id, kind: actor.kind, at: this.time(), summary: clean(value.summary, 6000),
        ...(value.journeys ? { journeys: value.journeys.map((journey) => ({ name: clean(journey.name, 200),
          expectedBehavior: clean(journey.expectedBehavior, 2000), evidencePaths: journey.evidencePaths.map((path) => clean(path, 500)) })) } : {}) });
      await this.assess(current.run, await this.options.capabilities(current.run));
      await this.save(current.run, current.head, current.head);
      await this.assessed(current.run);
      return current.run;
    });
  }
  private async execute(id: string): Promise<void> {
    let current = await this.read(CURRENT);
    if (!current || current.run.id !== id || !["queued", "running"].includes(current.run.status)) return;
    const run = current.run;
    const persist = async () => {
      const head = await this.save(run, current!.head, current!.head);
      current = { head, run };
    };
    try {
      run.status = "running";
      run.steps[0]!.status = "running";
      await persist();
      const tree = await this.options.git(["ls-tree", "-r", "-z", "--name-only", run.repository.head]);
      const files = tree.split("\0").filter(Boolean);
      const sources = await inspectBootstrapSources(this.options.git, run.repository.head, files, this.options.secrets);
      let manifest: unknown = null;
      if (files.includes("package.json")) {
        try { manifest = JSON.parse(await this.options.git(["show", `${run.repository.head}:package.json`])); }
        catch { /* A malformed or oversized manifest is not a verified command list. */ }
      }
      run.steps[0]!.status = "complete";
      run.steps[0]!.detail = `Inspected ${files.length} paths at ${run.repository.head.slice(0, 12)}; no repository code executed.`;
      run.artifacts = bootstrapArtifacts(files, manifest, run.mode).map((artifact) => {
        const content = redactModelText(artifact.content, this.options.secrets ?? [], 200_000);
        return { ...artifact, content, digest: sha(content) };
      });
      run.bootstrap = { schema: 1, setupId: run.id, head: run.repository.head, assessedAt: this.time(),
        nextAssessmentAt: this.nextAssessment(), sources, coverage: [], requests: [], contextReports: [] };
      // Preserve existing policy text. Choosing automatic setup never silently expands an existing policy's permissions.
      for (const path of ["autonomy.md", "thresholds.yaml", "intents/application.md"]) {
        const source = files.includes(path) ? path : files.includes(`ephyra/${path}`) ? `ephyra/${path}` : null;
        if (!source) continue;
        let content = redact(await this.options.git(["show", `${run.repository.head}:${source}`]), this.options.secrets ?? [], 200_000);
        if (path === "autonomy.md") {
          const policy = parseAutonomy(content);
          if (run.mode === "supervised") {
            policy.defaults.checkpoints = { A: "blocking", B: "blocking", C: "blocking" };
            for (const area of policy.areas) area.overrides = { A: "blocking", B: "blocking", C: "blocking" };
            content = renderAutonomy(policy);
          }
        }
        if (path === "thresholds.yaml") parseThresholds(content);
        run.artifacts = run.artifacts.map((a) => a.path === path ? { path, content, digest: sha(content) } : a);
      }
      for (const index of [1, 2, 3]) run.steps[index]!.status = "complete";
      run.steps[1]!.detail = "Autonomy configuration recorded; existing policy retained when present.";
      run.steps[2]!.detail = "Verification candidates and intent document recorded. Checks have not run.";
      run.steps[3]!.detail = "Telemetry source hints recorded. Source coverage is not yet verified.";
      run.steps[4]!.status = "running";
      await persist();
      const prerequisites = await this.options.capabilities(run);
      if (this.options.provision && !prerequisites.some((cap) => ["agent", "runner"].includes(cap.id) && !cap.available)) {
        run.steps[2]!.status = "running";
        run.steps[2]!.detail = "Provisioning a sandbox and running the repository's discovered checks.";
        await persist();
        const result = await this.options.provision(run);
        for (const artifact of result.artifacts) {
          run.artifacts = run.artifacts.filter((item) => item.path !== artifact.path);
          const content = redactModelText(artifact.content, this.options.secrets ?? [], 250_000);
          run.artifacts.push({ path: artifact.path, content, digest: sha(content) });
        }
        run.steps[2]!.status = result.verification ? "complete" : "blocked";
        run.steps[2]!.detail = result.detail;
        await persist();
      }
      const capabilities = await this.options.capabilities(run);
      await this.readiness(run, capabilities);
      await this.assess(run, capabilities);
      await persist();
      await this.schedule(run);
      await this.assessed(run);
      if (run.investigationActive) await this.options.activate(run);
    } catch {
      // Never serialize raw Git/provider errors or repository content as an error message.
      run.status = "failed";
      const step = run.steps.find((s) => s.status === "running") ?? run.steps[0]!;
      step.status = "failed";
      step.detail = "This setup step could not be verified. Inspect the recorded artifacts and run setup again.";
      await persist();
    }
  }
}
