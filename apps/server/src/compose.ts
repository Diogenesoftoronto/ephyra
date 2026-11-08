// Composition root: config → stores (Convex or memory) → engine → effect handlers → HTTP app.
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Hono } from "hono";
import {
  ProofItem, Unverified, sha256Hex, systemIds, type Budget, type CodingAgent, type DecideBackend, type Effect, type ExtractBackend, type Runner,
  type ServiceProfile, type SignalStore, type Trail, type TransitionContext,
} from "@ephyra/core";
import { MemorySignalStore, otlpRoutes } from "@ephyra/ingest";
import { GitJournal } from "@ephyra/journal";
import {
  AUTONOMY_TEMPLATE, THRESHOLDS_TEMPLATE, areaFor, checkpointMode, parseAutonomy, parseThresholds, type AutonomyPolicy,
} from "@ephyra/policy";
import { ParserExtract, SystemOneHttpDecide, TypeSafeDecide, WorkersAiClairicExtract, dpopProof } from "@ephyra/models";
import { LocalRunner } from "@ephyra/runner";
import { AmpAgent, AmpReportInbox, ClaudeCodeAgent, CodexAgent, buildProof, runAgent, type AmpThreadStore } from "@ephyra/agent";
import { PlainGitAdapter } from "@ephyra/forge";
import { TractionEvidence } from "@ephyra/evidence";
import { MemoryAudit } from "./audit.ts";
import { approverDids, type Config } from "./config.ts";
import { SecretBox } from "./auth/crypto.ts";
import { HostedDecide, HostedExtract } from "./auth/hosted.ts";
import { NotOrganicSignIn } from "./auth/notorganic.ts";
import { authRoutes } from "./auth/routes.ts";
import { ConvexAuthStore, MemoryAuthStore } from "./auth/store.ts";
import { createApp } from "./http/app.ts";
import { consoleRoutes, type ConsolePort } from "./http/console.ts";
import { voiceRoutes } from "./http/voice.ts";
import { tutorRoutes } from "./http/tutor.ts";
import { AmpersandDraftModel, TUTOR_MODEL } from "./humans.ts";
import { TutorService, NotOrganicTutorBackend, DirectTutorBackend, type TutorBackend } from "./tutor.ts";
import { VoiceService } from "./voice.ts";
import { voiceContext } from "./voice-context.ts";
import { CompatibleSpeechProvider, type SpeechProvider } from "./voice-provider.ts";
import { consoleStatic, hasConsole } from "./http/static.ts";
import { activity } from "./activity.ts";
import { ConvexRunStore, MemoryRunStore, RunBroker, RunRecorder, type RunStore } from "./runs.ts";
import { ConvexDraftStore, DraftService, MemoryDraftStore } from "./drafts.ts";
import { PolicyDocs } from "./docs.ts";
import { ConvexUsageStore, MemoryUsageStore, UsageRecorder, type BilledTo, type UsageStore } from "./usage.ts";
import {
  AnthropicDraftModel, FakeDraftModel, NotOrganicDraftModel, OpenAiDraftModel, Velum, type DraftModel,
} from "./velum.ts";
import { ConvexAudit, ConvexOperationLedger, ConvexRuntimeStore, ConvexSignalStore, convexClient, scopedConvexClient } from "./convex/stores.ts";
import { MemoryOperationLedger } from "./orchestrator/effects.ts";
import type { EffectHandlers } from "./orchestrator.ts";
import type { RepoConfig, ServerContext } from "./wiring/context.ts";
import { MemoryStore, type RuntimeStore } from "./wiring/store.ts";
import { Engine, JobLoop } from "./wiring/runtime.ts";
import { intake, intakeHandlers } from "./wiring/intake.ts";
import { httpPort, humanHandlers, type AuditSink } from "./wiring/human.ts";
import { agentHandlers, type BuildProofFn, type AgentDeps } from "./wiring/agents.ts";
import { landingHandlers, type Git } from "./wiring/landing.ts";
import { checkpointHandlers } from "./wiring/checkpoints.ts";
import { AutomaticSetup, setupGit, type SetupOptions } from "./setup/automation.ts";
import { setupRoutes } from "./http/setup.ts";
import { InvestigationQuestions, type QuestionOptions } from "./setup/questions.ts";
import { registerPostHogPolling } from "./setup/telemetry.ts";
import { telemetryCoverage } from "./setup/bootstrap-coverage.ts";
import { BootstrapEvidence } from "./setup/bootstrap-evidence.ts";
import { BootstrapContact, type BootstrapContactOptions } from "./setup/bootstrap-contact.ts";
import { PolicyActivation } from "./policy-activation.ts";
import { ampReportRoutes } from "./amp-reports.ts";
import { GitProbeCatalog, probeHandlers, type ProbeHandlerDeps } from "./wiring/probes.ts";
import { createVerificationCollector, repositoryVerificationCommands, type VerificationOptions } from "./wiring/verification.ts";
import { WorkControl } from "./wiring/control.ts";
import { workBudget } from "./wiring/budget.ts";
import { isolatedProbeRunner } from "./wiring/probe-runtime.ts";
import { TrustedProofReceipts } from "./proof-receipts.ts";
import { releaseRevision } from "./release.ts";
import { WorkerOwnershipLost } from "./wiring/worker-lease.ts";
import type { LandingDeps } from "./wiring/landing.ts";

export const VERSION = "0.1.0-prealpha";

export type Composed = {
  app: Hono;
  decide: DecideBackend | null;
  signIn: NotOrganicSignIn | null;
  mode: "memory" | "convex";
  ctx: ServerContext;
  usage: UsageStore;
  /** Audit entries written in memory mode (empty with Convex, whose log is read through its own query). */
  memoryAudit: MemoryAudit;
  runs: RunStore;
  runBroker: RunBroker;
  drafts: DraftService;
  /** The model behind Velum, or null when EPHYRA_DRAFT=none. */
  draftModel: DraftModel | null;
  engine: Engine;
  jobs: JobLoop;
  setup: AutomaticSetup;
  questions: InvestigationQuestions | null;
  telemetry: ReturnType<typeof registerPostHogPolling> | null;
  /** Runs a delegated mutation under the same captured workspace fence as HTTP mutations. */
  withOwner<T>(work: () => Promise<T>): Promise<T>;
  health(): Promise<{ store: "ok" | "unavailable" | "memory" }>;
  start(): Promise<void>;
  close(): Promise<void>;
};

const ALL_EFFECTS: Effect["type"][] = [
  "run_triage", "start_agent", "run_proof", "request_checkpoint", "request_spend", "land", "rebase", "start_watch",
  "rollback", "register_regression_probe", "notify_inbox", "stop_agent", "merge_signal", "resume_dependents",
  "mute_fingerprint", "run_probes", "reply_comment", "start_respondent_run", "deliver_child_evidence",
];

/** Effects with no wiring yet fail into reconciliation with a clear note, never crash. */
function notWired(type: string) {
  return async () => { throw new Error(`${type} is not wired on this deployment`); };
}

function git(dir: string, isolated = false): Git {
  return async (args, opts) => {
    const proc = Bun.spawn(["git", "--git-dir", dir, ...args], {
      stdin: opts?.input ? new Blob([opts.input]) : "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...(isolated ? {
        PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      } : process.env), ...opts?.env },
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim().slice(0, 300)}`);
    return out;
  };
}

async function prepareWorkspace(repo: RepoConfig, log: ServerContext["log"]): Promise<void> {
  await mkdir(repo.mirrorDir, { recursive: true });
  const g = git(repo.mirrorDir);
  try { await g(["rev-parse", "--git-dir"]); } catch { await Bun.spawn(["git", "init", "--bare", "-q", repo.mirrorDir]).exited; }
  if (!repo.url) return;
  const remotes = (await g(["remote"])).split("\n");
  if (!remotes.includes(repo.remote)) await g(["remote", "add", repo.remote, repo.url]);
  try {
    await g(["fetch", "--prune", repo.remote, `+${repo.baseRef}:${repo.baseRef}`]);
  } catch (error) {
    log("workspace fetch failed", { error: String(error) });
  }
}

async function readOptional(path: string | undefined, fallback: string): Promise<string> {
  return path ? readFile(path, "utf8") : fallback;
}

function contextFn(autonomy: AutonomyPolicy) {
  return async (trail: Trail): Promise<TransitionContext> => {
    const area = autonomy.areas.find((a) => a.name === trail.area);
    const blocking = (c: "A" | "B" | "C") => c === "C" && ["high", "critical"].includes(trail.risk)
      || !area || checkpointMode(autonomy, area, c) === "blocking";
    return {
      now: new Date().toISOString(),
      blocking: { A: blocking("A"), B: blocking("B"), C: blocking("C") },
      landingModes: area?.landing ?? autonomy.defaults.landing,
    };
  };
}

function backends(config: Config, usage: UsageRecorder): { extract: ExtractBackend | null; decide: DecideBackend | null } {
  let extract: ExtractBackend | null = null;
  if (config.EPHYRA_EXTRACT === "parser") extract = new ParserExtract();
  if (config.EPHYRA_EXTRACT === "workers-ai") {
    extract = new WorkersAiClairicExtract({
      alias: "clairic", accountId: config.CLOUDFLARE_ACCOUNT_ID!, credential: config.CLOUDFLARE_AI_API_TOKEN!,
      onUsage: usage.modelHook("byok"),
    });
  }
  let decide: DecideBackend | null = null;
  if (config.EPHYRA_DECIDE === "typesafe") {
    decide = new TypeSafeDecide({
      alias: "jev", endpoint: "https://api.typesafe.ai", credential: config.TYPESAFE_API_KEY!, model: config.TYPESAFE_MODEL,
      supports: ["noul", "choice", "score"], purpose: "decide.triage",
      onUsage: usage.modelHook("byok"),
    });
  }
  if (config.EPHYRA_DECIDE === "systemone") {
    decide = new SystemOneHttpDecide({
      alias: "systemone", endpoint: config.EPHYRA_SYSTEMONE_URL!, credential: config.EPHYRA_SYSTEMONE_KEY ?? "",
      model: config.EPHYRA_SYSTEMONE_MODEL!, supports: ["noul", "choice", "score"], purpose: "decide.triage",
      // A keyed endpoint is someone's account; an unkeyed one could be self-hosted or not, so it stays unknown.
      onUsage: usage.modelHook(config.EPHYRA_SYSTEMONE_KEY ? "byok" : "unknown"),
    }, "systemone");
  }
  return { extract, decide };
}

/** Configured credentials, so run events can scrub them by value as well as by pattern. */
function knownSecrets(config: Config): string[] {
  return [
    config.EPHYRA_API_TOKEN, config.EPHYRA_CONVEX_SECRET, config.EPHYRA_SESSION_KEY, config.TYPESAFE_API_KEY, config.EPHYRA_SYSTEMONE_KEY,
    config.CLOUDFLARE_AI_API_TOKEN, config.EPHYRA_DRAFT_ANTHROPIC_API_KEY, config.EPHYRA_DRAFT_OPENAI_API_KEY, process.env.AMP_API_KEY,
    config.EPHYRA_VOICE_API_KEY, config.EPHYRA_HUMANS_API_KEY,
    config.EPHYRA_TRACTION_TOKEN,
    config.EPHYRA_RAILWAY_TOKEN,
  ].filter((v): v is string => typeof v === "string" && v.length >= 8);
}

function agentBilledTo(config: Config): BilledTo {
  if (config.EPHYRA_AGENT === "amp") return config.EPHYRA_AMP_EXECUTOR === "local" ? "local" : "byok";
  return config.EPHYRA_AGENT === "none" ? "unknown" : "local";
}

function agentFor(config: Config, ampThreads: AmpThreadStore, reports?: AmpReportInbox): CodingAgent | null {
  if (config.EPHYRA_AGENT === "claude-code") return new ClaudeCodeAgent(config.EPHYRA_AGENT_MODEL ?? "claude-opus-5-5");
  if (config.EPHYRA_AGENT === "codex") return new CodexAgent(config.EPHYRA_AGENT_MODEL ?? "gpt-6.1-sol");
  if (config.EPHYRA_AGENT === "amp") {
    const executor = config.EPHYRA_AMP_EXECUTOR === "orb"
      ? { kind: "orb" as const, ...(config.EPHYRA_AMP_PROJECT ? { project: config.EPHYRA_AMP_PROJECT } : {}) }
      : config.EPHYRA_AMP_EXECUTOR === "runner"
        ? { kind: "runner" as const, runnerId: config.EPHYRA_AMP_RUNNER_ID! }
        : { kind: "local" as const };
    return new AmpAgent({ executor, mode: config.EPHYRA_AMP_MODE, threads: ampThreads, reports });
  }
  return null;
}

/** Each trail's Amp thread id lives on the trail itself (trail.mirrors.ampThread), read from the projection. */
function ampThreadsFrom(store: RuntimeStore): AmpThreadStore {
  const pending = new Map<string, string>();
  return {
    get: async (trailId) => pending.get(trailId) ?? (await store.getTrail(trailId))?.mirrors.ampThread ?? null,
    set: async (trailId, threadId) => { pending.set(trailId, threadId); },
  };
}

function draftModelFor(config: Config, signIn: NotOrganicSignIn | null, billingDid: string | undefined,
  ledger: import("@ephyra/core").OperationLedger): DraftModel | null {
  switch (config.EPHYRA_DRAFT) {
    case "notorganic": return signIn && billingDid ? new NotOrganicDraftModel(signIn, billingDid, config.EPHYRA_DRAFT_MODEL) : null;
    case "anthropic": return new AnthropicDraftModel(config.EPHYRA_DRAFT_ANTHROPIC_API_KEY!, config.EPHYRA_DRAFT_MODEL);
    case "openai": return new OpenAiDraftModel(config.EPHYRA_DRAFT_OPENAI_API_KEY!, config.EPHYRA_DRAFT_MODEL);
    case "ampersand": return new AmpersandDraftModel(config.EPHYRA_HUMANS_API_KEY!, ledger);
    case "fake": return new FakeDraftModel();
    default: return null;
  }
}

/** Token bucket per ingest key. */
function quota(perMinute: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) { buckets.set(key, b); return false; }
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  };
}

export type ComposeOverrides = {
  ampReports?: AmpReportInbox;
  verification?: Pick<VerificationOptions, "commands" | "sources">;
  respondents?: ProbeHandlerDeps["respondents"];
  landing?: (context: {
    ctx: ServerContext; ledger: import("@ephyra/core").OperationLedger; probes: GitProbeCatalog;
    runProbe: NonNullable<ProbeHandlerDeps["run"]>;
    telemetry: ReturnType<typeof registerPostHogPolling> | null;
  }) => Promise<Omit<LandingDeps, "git" | "watchEveryMs">>;
  startJobs?: boolean;
  /** Replaces the fetch used to talk to Not Organic (tests). */
  notOrganicFetch?: import("./auth/crypto.ts").Fetch;
  /** Test/dev injection points. */
  agent?: CodingAgent;
  runner?: Runner;
  profile?: ServiceProfile;
  operationLedger?: import("@ephyra/core").OperationLedger;
  questions?: Omit<QuestionOptions, "ctx" | "decide" | "ledger">;
  bootstrapContact?: Omit<BootstrapContactOptions, "ctx" | "ledger" | "current">;
  resolveTelemetry?: () => Promise<import("@ephyra/evidence").PostHogEvidence | null>;
  setupProvision?: SetupOptions["provision"];
  assessBootstrap?: SetupOptions["assess"];
  prepareProof?: AgentDeps["prepareProof"];
  decide?: DecideBackend;
  /** Replaces the configured Velum model (tests: nothing here may touch the network). */
  draftModel?: DraftModel;
  speechProvider?: SpeechProvider;
  tutorBackend?: TutorBackend;
  workspace?: string;
  signIn?: NotOrganicSignIn;
  /** Personal repos are fetched through the constrained connector, never through deployment Git. */
  workspacePrepared?: boolean;
  setupScopes?: (did: string) => Promise<string[]>;
  resolveDraftModel?: () => Promise<DraftModel | null>;
  /** Operator-provided, workspace-scoped capabilities verified by the hosting integration. Never inferred from a URL. */
  automationReadiness?: Partial<Record<"telemetry" | "verification" | "landing" | "watch", boolean>>;
  evidenceSources?: import("@ephyra/core").EvidenceSource[];
  /** Current account choices are resolved for each research attempt, using this workspace's durable ledger. */
  resolveEvidenceSources?: (ledger: import("@ephyra/core").OperationLedger) => Promise<import("@ephyra/core").EvidenceSource[]>;
};

export async function compose(config: Config, opts: ComposeOverrides = {}): Promise<Composed> {
  const log: ServerContext["log"] = (msg, fields) => console.log(JSON.stringify({ msg, ...fields }));
  const baseClient = config.CONVEX_URL ? convexClient({ url: config.CONVEX_URL, secret: config.EPHYRA_CONVEX_SECRET! }) : null;
  const client = baseClient && opts.workspace ? scopedConvexClient(baseClient, opts.workspace) : baseClient;
  const secret = config.EPHYRA_CONVEX_SECRET ?? "";
  const durableStore = client ? new ConvexRuntimeStore(client, secret) : null;
  const store: RuntimeStore = durableStore ?? new MemoryStore();
  const signals: SignalStore = client ? new ConvexSignalStore(client, secret) : new MemorySignalStore();
  const ledger = opts.operationLedger ?? (client ? new ConvexOperationLedger(client, secret) : new MemoryOperationLedger());
  const usageStore: UsageStore = client ? new ConvexUsageStore(client, secret) : new MemoryUsageStore();
  const usage = new UsageRecorder(usageStore, log);
  const runStore: RunStore = client ? new ConvexRunStore(client, secret, () => durableStore!.ownerClaim()) : new MemoryRunStore();
  const runBroker = new RunBroker();
  const runs = new RunRecorder(runStore, runBroker, log);
  const memoryAudit = new MemoryAudit();
  const audit: AuditSink = client ? new ConvexAudit(client, secret) : { append: async (i) => memoryAudit.append(i) };

  const repo: RepoConfig = {
    id: config.EPHYRA_REPO_ID, url: config.EPHYRA_REPO_URL ?? "", mirrorDir: join(config.EPHYRA_DATA_DIR, "workspace.git"),
    baseRef: config.EPHYRA_BASE_REF, forge: config.EPHYRA_FORGE, remote: "origin",
  };
  if (!opts.workspacePrepared) await prepareWorkspace(repo, log);
  const autonomy = parseAutonomy(await readOptional(config.EPHYRA_AUTONOMY_FILE, AUTONOMY_TEMPLATE));
  const thresholds = parseThresholds(await readOptional(config.EPHYRA_THRESHOLDS_FILE, THRESHOLDS_TEMPLATE));
  const journal = new GitJournal({ gitDir: repo.mirrorDir, clock: { now: () => new Date() } });
  const jobs = new JobLoop(store, log);
  const engine = new Engine(store, journal, ledger, contextFn(autonomy), systemIds, log);
  if (durableStore) engine.setOwnershipGuard(() => durableStore.assertOwner());

  const ctx: ServerContext = {
    repo, policy: { autonomy, thresholds }, journal, signals, clock: { now: () => new Date() }, ids: systemIds, log,
    inbox: {
      put: (item) => store.inboxPut(item), remove: (id) => store.inboxRemove(id),
      get: (id) => store.inboxGet(id), list: () => store.inboxList(),
    },
    jobs: { register: (k, r) => jobs.register(k, r), enqueue: (k, key, p, o) => jobs.enqueue(k, key, p, o) },
    emit: async (input) => { await engine.emit(input); },
    start: async (trail, initial, effects) => {
      await activation?.restore();
      const current = await activation?.current();
      await engine.start({ ...trail, ...(current ? { policyCommit: current.commit } : {}) }, initial, effects ?? []);
    },
    trails: {
      get: (id) => store.getTrail(id), list: (f) => store.listTrails(f?.states), events: (id) => store.events(id),
    },
  };

  const g = git(repo.mirrorDir, Boolean(opts.workspace));
  const budget: Budget = {
    tokensUsed: 0, tokensMax: config.EPHYRA_TRAIL_TOKENS, wallclockMaxS: config.EPHYRA_TRAIL_WALLCLOCK_S,
    spendMicrousdUsed: 0, spendMicrousdMax: config.EPHYRA_TRAIL_SPEND_MICROUSD, requireKnownCost: config.EPHYRA_REQUIRE_KNOWN_COST,
  };
  const approvers = new Set(approverDids(config));
  let signIn: NotOrganicSignIn | null = opts.signIn ?? null;
  if (!signIn && config.EPHYRA_PUBLIC_ORIGIN && config.EPHYRA_SESSION_KEY) {
    signIn = new NotOrganicSignIn(
      {
        issuer: config.NOTORGANIC_ISSUER, authorizationUrl: config.NOTORGANIC_AUTHORIZATION_URL,
        publicOrigin: config.EPHYRA_PUBLIC_ORIGIN, product: config.NOTORGANIC_PRODUCT,
        scopes: [
          "wallet:read", "usage:read", "judgement:evaluate", "extraction:run",
          // Velum on Not Organic chat needs the model's inference scope; asked for only when it is in use.
          ...(config.EPHYRA_DRAFT === "notorganic" ? [`infer:${config.EPHYRA_DRAFT_MODEL ?? "balanced"}`] : []),
          ...(config.EPHYRA_TUTOR === "notorganic" ? [`infer:${TUTOR_MODEL}`] : []),
          ...(config.EPHYRA_VOICE === "notorganic"
            ? [...new Set([config.EPHYRA_VOICE_STT_MODEL!, config.EPHYRA_VOICE_TTS_MODEL!])].map(m => `infer:${m}`) : []),
        ],
      },
      baseClient ? new ConvexAuthStore(baseClient, secret) : new MemoryAuthStore(),
      await SecretBox.fromBase64(config.EPHYRA_SESSION_KEY),
      opts.notOrganicFetch,
    );
  }
  const billingDid = config.EPHYRA_BILLING_DID ?? [...approvers][0];
  const configured = backends(config, usage);
  const hosted = usage.modelHook("notorganic");
  const extract = config.EPHYRA_EXTRACT === "notorganic" && signIn && billingDid ? new HostedExtract(signIn, billingDid, hosted) : configured.extract;
  const decide = opts.decide
    ?? (config.EPHYRA_DECIDE === "notorganic" && signIn && billingDid ? new HostedDecide(signIn, billingDid, hosted) : configured.decide);
  const draftModel = opts.draftModel ?? draftModelFor(config, signIn, billingDid, ledger);
  const profile: ServiceProfile = opts.profile ?? {
    name: "local", digest: "local", network: "egress", readOnlyProd: true, credentials: [],
    limits: { cpu: 2, memoryMb: 4096, diskMb: 8192, timeoutS: config.EPHYRA_STEP_TIMEOUT_S },
  };
  const agent = opts.agent ?? agentFor(config, ampThreadsFrom(store), opts.ampReports);
  const runner: Runner | null = opts.runner
    ?? (agent ? new LocalRunner(join(config.EPHYRA_DATA_DIR, "runner"), { trusted: true, allowDevenv: false }) : null);
  const evidenceSources = opts.evidenceSources ?? (!opts.workspace && config.EPHYRA_TRACTION_ORIGIN ? [new TractionEvidence({
    origin: config.EPHYRA_TRACTION_ORIGIN,
    scope: { accountId: billingDid ?? "deployment", workspaceId: repo.id,
      projectIds: config.EPHYRA_TRACTION_PROJECTS!.split(",").map((id) => id.trim()) },
    credential: async () => config.EPHYRA_TRACTION_TOKEN!,
  })] : []);
  let currentSetup: () => Promise<import("@ephyra/core").SetupRun | null> = async () => null;
  let investigationWasActive = false;
  let setupCleanupUncertain = false;
  const setupCleanupKey = `bootstrap-cleanup:${repo.id}`;
  const canInvestigate = async () => {
    if (!opts.workspace) return true;
    if (setupCleanupUncertain) return false;
    try {
      const run = await currentSetup();
      if (!run?.investigationActive || !["ready", "blocked"].includes(run.status)) return false;
      return (await g(["rev-parse", repo.baseRef])).trim() === run.repository.head;
    } catch { return false; }
  };
  const bootstrapEvidence = new BootstrapEvidence({ workspaceId: repo.id, current: () => currentSetup(), secrets: knownSecrets(config) });
  const intakeHooks = intake(ctx, {
    extract, decide, budget, canInvestigate,
    baseSha: async () => (await g(["rev-parse", repo.baseRef])).trim(),
  });
  const questions = opts.questions ? new InvestigationQuestions({ ...opts.questions, ctx, decide, ledger }) : null;
  let onTelemetryObservation = async () => {};
  const telemetry = opts.resolveTelemetry ? registerPostHogPolling({ ctx, resolve: opts.resolveTelemetry, ledger,
    onSignal: (signal) => intakeHooks.onNewSignal(signal), onObservation: () => onTelemetryObservation() }) : null;
  const control = new WorkControl();
  let activation: PolicyActivation | undefined;
  let appliedPolicy: string | undefined;
  ctx.refreshPolicy = async () => { await activation?.restore(); };
  const probes = new GitProbeCatalog({ git: g, journal, secrets: knownSecrets(config), intentDocuments: async () => {
    const current = await activation?.current();
    if (!current) return [];
    const paths = (await activation!.paths()).filter(path => path.startsWith("intents/"));
    return Promise.all(paths.map(async (path) => ({ path, content: (await activation!.content(path))!, commit: current.commit })));
  } });
  const proofReceipts = config.EPHYRA_PROOF_RECEIPTS_DIR ? new TrustedProofReceipts({
    directory: config.EPHYRA_PROOF_RECEIPTS_DIR, trustFile: config.EPHYRA_PROOF_TRUST_FILE!,
  }) : null;
  const isolatedRunProbe = isolatedProbeRunner({ ctx, runner, profile, ledger, control, prepare: opts.prepareProof,
    timeoutS: config.EPHYRA_STEP_TIMEOUT_S, secrets: knownSecrets(config) });
  const runProbe: typeof isolatedRunProbe = async (...args) => {
    if (!await canInvestigate()) throw new Unverified("workspace investigation readiness");
    return isolatedRunProbe(...args);
  };
  const landing = await opts.landing?.({ ctx, ledger, probes, runProbe, telemetry });
  const human = humanHandlers(ctx);
  const notify = human.notify_inbox!;
  if (questions) human.notify_inbox = async (effect, trail) => {
    await notify(effect, trail);
    await questions.schedule(trail, effect.reason, effect.key);
  };
  const slices = [
    intakeHandlers(ctx),
    human,
    checkpointHandlers(ctx, { decide, ledger, secrets: knownSecrets(config) }),
    agentHandlers(ctx, { runner, agent, profile, control, buildProof: buildProof as unknown as BuildProofFn,
      canInvestigate,
      stepTimeoutS: config.EPHYRA_STEP_TIMEOUT_S,
      usage, agentBilledTo: agentBilledTo(config), runs, secrets: knownSecrets(config),
      prepareProof: opts.prepareProof,
      createProofCollector: (trail, observer) => createVerificationCollector({ catalog: probes, journal, ...opts.verification,
        commands: opts.verification?.commands ?? (() => repositoryVerificationCommands(g, trail)),
        sources: async evidence => [...await opts.verification?.sources?.(evidence) ?? [],
          ...await proofReceipts?.collect(repo.id, evidence) ?? []],
        secrets: knownSecrets(config),
        review: agent && trail.risk !== "low" ? async (evidence) => {
          const ms = evidence.remainingMs();
          const budget = workBudget((await ctx.trails.get(trail.id)) ?? trail, ms / 1000);
          if (budget.reason) throw new Unverified(budget.reason);
          let diff = "", exit: number | undefined;
          for await (const part of evidence.runner.exec(evidence.handle, ["git", "diff", "--no-ext-diff", evidence.base, evidence.head], {
            deadlineMs: evidence.remainingMs(), signal: observer.signal,
          })) {
            if ("chunk" in part) { if (part.stream === "stdout") diff += part.chunk; }
            else { if (part.timedOut) throw new Unverified("review diff timeout"); exit = part.exit; }
            if (diff.length > 200_000) throw new Unverified("bounded review diff");
          }
          if (exit !== 0) throw new Unverified("observed review diff");
          let reported = false;
          const result = await runAgent(agent, { step: "review", trail, context: {}, untrusted: { diff },
            budget: { tokens: budget.tokens, wallclockS: budget.wallclockS,
              ...(budget.spendMicrousd !== undefined ? { spendMicrousd: budget.spendMicrousd } : {}) } },
          evidence.runner, evidence.handle, { ...observer, secrets: knownSecrets(config), onUsage: async (receipt) => {
            await observer.onUsage(receipt); reported = true;
          } }).catch(async (error) => {
            if (!reported) await observer.onUsage({ key: `proof-review:${trail.id}:${trail.rev}:${evidence.handle.id}:unavailable`,
              tokens: null, costMicrousd: null, model: agent.name });
            throw error;
          });
          if (!reported) await observer.onUsage({ key: `proof-review:${trail.id}:${trail.rev}:${evidence.handle.id}`, ...result.usage });
          if (!result.ok) throw new Unverified("successful review agent result");
          const item = ProofItem.parse({ kind: "bug_review", reviewer: result.usage.model,
            findings: JSON.parse(result.artefacts["review.json"] ?? "null")?.findings });
          if (item.kind !== "bug_review") throw new Unverified("review findings");
          return item;
        } : undefined,
        onReceipts: async (evidence, receipts) => {
          const current = await journal.read(trail.id);
          if (!current || current.trail.rev !== trail.rev || current.trail.head !== trail.head
            || current.trail.policyCommit !== trail.policyCommit || current.trail.workGeneration !== trail.workGeneration)
            throw new Unverified("proof receipt revision");
          await journal.append(trail.id, current.head, current.trail, [], {
            [`proof/receipts/${evidence.trail.rev}.json`]: JSON.stringify(receipts),
          });
        },
      }),
      resolveEvidenceSources: async () => {
        const sources = [...evidenceSources, ...await opts.resolveEvidenceSources?.(ledger) ?? []];
        return (await currentSetup())?.bootstrap ? [bootstrapEvidence, ...sources] : sources;
      } }),
    landingHandlers(ctx, {
      adapters: landing?.adapters ?? [new PlainGitAdapter(repo.mirrorDir, undefined, repo.id, repo.mirrorDir, ledger)],
      git: g, watchEveryMs: config.EPHYRA_WATCH_EVERY_S * 1000,
      watch: landing?.watch, refreshBase: landing?.refreshBase,
      canLand: opts.workspace ? async () => (await currentSetup())?.status === "ready" && await canInvestigate()
        && (!landing?.canLand || await landing.canLand()) : landing?.canLand,
    }),
    probeHandlers(ctx, { catalog: probes, ledger, run: runProbe, onSignal: intakeHooks.onNewSignal,
      respondents: opts.respondents, secrets: knownSecrets(config) }),
  ];
  const handlers = Object.fromEntries(ALL_EFFECTS.map((t) => [t, notWired(t)])) as unknown as EffectHandlers;
  for (const slice of slices) Object.assign(handlers, slice);
  engine.setHandlers(handlers);

  const setup = new AutomaticSetup({
    git: async (args, options) => {
      const writing = ["hash-object", "mktree", "commit-tree", "update-ref"].includes(args[0] ?? "");
      if (writing) durableStore?.assertOwner();
      const result = await setupGit(repo.mirrorDir)(args, options);
      if (writing) durableStore?.assertOwner();
      return result;
    }, repo, jobs: ctx.jobs, secrets: knownSecrets(config),
    provision: opts.setupProvision,
    onAssessed: async (run) => {
      const active = run.status === "ready" || run.investigationActive === true;
      if (opts.workspace && investigationWasActive && !active) {
        const receipts = await control.stopAll();
        setupCleanupUncertain ||= receipts.some(receipt => ["pending_allocation", "reconciliation_required"].includes(receipt.status));
        if (setupCleanupUncertain) {
          await ledger.begin(setupCleanupKey, sha256Hex(setupCleanupKey));
          await ledger.markAmbiguous(setupCleanupKey, "Workspace readiness changed and runner cleanup requires reconciliation.");
          log("bootstrap runner cleanup needs reconciliation", { receipts });
        }
      }
      investigationWasActive = active;
      await bootstrapContact?.schedule(run);
    },
    assess: async (run) => {
      // Observation starts during bootstrap, independently of coding/landing readiness.
      await telemetry?.start();
      return [...await opts.assessBootstrap?.(run) ?? [], await telemetryCoverage(telemetry, opts.resolveTelemetry)];
    },
    capabilities: async (run) => {
      const cleanup = await ledger.get(setupCleanupKey);
      setupCleanupUncertain ||= Boolean(cleanup && cleanup.status !== "done");
      let baseline = false;
      try {
        const receipt = JSON.parse(run?.artifacts.find((a) => a.path === "ephyra/provisioning.json")?.content ?? "null");
        baseline = receipt?.verification === true && receipt.head === run?.repository.head;
      } catch { /* an invalid receipt cannot establish readiness */ }
      const setupPolicy = run?.artifacts.find(artifact => artifact.path === "autonomy.md")?.content;
      const proofPolicy = setupPolicy ? parseAutonomy(setupPolicy) : autonomy;
      const proofAreas = [...proofPolicy.areas, proofPolicy.fallback];
      const requiredSources = new Set<"persona_study" | "voxq_study" | "visual_approval">();
      for (const area of proofAreas) {
        if (area.user_facing && area.risk !== "low") requiredSources.add("persona_study");
        if (area.user_facing && ["high", "critical"].includes(area.risk)) requiredSources.add("voxq_study");
        if (area.ui.length && ["high", "critical"].includes(area.risk)) requiredSources.add("visual_approval");
      }
      const externalProofReady = Boolean(opts.verification?.sources) || (await Promise.all([...requiredSources]
        .map(kind => proofReceipts?.supports(repo.id, kind).catch(() => false) ?? false))).every(Boolean);
      return [
      { id: "agent", available: Boolean(agent) && (!opts.resolveDraftModel || Boolean(await opts.resolveDraftModel().catch(() => null))),
        summary: "A coding agent is not configured for this workspace.",
        action: "Connect a workspace-scoped coding agent on the host." },
      { id: "runner", available: Boolean(runner) && !setupCleanupUncertain,
        summary: setupCleanupUncertain ? "An earlier execution sandbox needs cleanup reconciliation." : "An execution sandbox is not configured.",
        action: setupCleanupUncertain ? "Reconcile the recorded runner cleanup before restoring investigation."
          : "Provision an isolated workspace runner through the hosting integration." },
      { id: "decision", available: Boolean(decide) && (config.EPHYRA_DECIDE !== "notorganic" || !signIn || !billingDid
          || await signIn.hasScope(billingDid, "judgement:evaluate")), summary: "A checkpoint decision model is not configured.",
        action: "Connect the decision backend and calibrate its exact returned identity." },
      { id: "telemetry", available: opts.automationReadiness?.telemetry === true
          || (await telemetry?.latest())?.result.coverage?.complete === true,
        summary: "Live telemetry coverage is unverified.",
        action: "Connect scoped error telemetry and verify ingestion for this repository." },
      { id: "verification", available: opts.automationReadiness?.verification === true || baseline,
        summary: "Repository checks have not been baselined.",
        action: "Run the discovered checks in the sandbox and record baseline failures and intent probes." },
      { id: "external_proof", available: externalProofReady,
        summary: "User-facing repairs need a trusted study evidence source.",
        action: "Configure operator receipts or signed provider receipts for this workspace; each repair still needs its own completed study." },
      { id: "landing", available: Boolean(landing?.adapters.length && landing.watch && (!landing.canLand || await landing.canLand())),
        summary: "Remote landing access is unverified.",
        action: "Verify the selected forge transport and rollback permissions for this workspace." },
      { id: "watch", available: Boolean(landing?.watch && (!landing.canLand || await landing.canLand())),
        summary: "Post-landing watch coverage is unverified.",
        action: "Verify the deployed revision, telemetry baseline and regression watch before enabling landing." },
    ]; },
    activate: async (run) => {
      const policy = run.artifacts.find((a) => a.path === "autonomy.md");
      const calibration = run.artifacts.find((a) => a.path === "thresholds.yaml");
      if (!policy || !calibration) throw new Error("Setup policy artifacts are missing.");
      Object.assign(autonomy, parseAutonomy(policy.content));
      for (const key of Object.keys(thresholds)) delete thresholds[key];
      Object.assign(thresholds, parseThresholds(calibration.content));
      await activation?.restore();
      await telemetry?.start();
    },
  });
  currentSetup = () => setup.current();
  const bootstrapContact = opts.bootstrapContact ? new BootstrapContact({ ...opts.bootstrapContact,
    ctx, ledger, current: () => setup.current(), secrets: [...knownSecrets(config), ...opts.bootstrapContact.secrets ?? []] }) : null;
  onTelemetryObservation = async () => { await setup.reassess(); };
  if (!durableStore) await setup.restore();

  // OTLP ingest, authenticated with the API token.
  const otlp = otlpRoutes({
    store: signals, quota: quota(600), maxBodyBytes: 4_000_000,
    onNewSignal: async (s) => {
      log("new signal", { fingerprint: s.fingerprint, service: s.service });
      // Without a repository there is no base commit to open a trail on: keep the signal, skip triage.
      if (!repo.url) { log("signal stored; no repository configured, triage skipped", { fingerprint: s.fingerprint }); return; }
      await intakeHooks.onNewSignal(s);
    },
  });
  const ingest = new Hono();
  ingest.use("*", async (c, next) => {
    if (c.req.header("Authorization") !== `Bearer ${config.EPHYRA_API_TOKEN}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  ingest.route("/", otlp);

  const port = httpPort(ctx, audit);
  port.ops = async () => ({
    deadJobs: await store.deadJobs(),
    reconciliations: ledger instanceof ConvexOperationLedger ? await ledger.reconciliations() : engine.reconciliations,
    worker: (() => {
      if (!durableStore) return { mode: "memory", active: true };
      try { return { mode: "convex", active: true, fence: durableStore.ownerClaim().fence }; }
      catch { return { mode: "convex", active: false }; }
    })(),
    backends: { extract: extract?.alias ?? null, decide: decide?.alias ?? null, agent: agent?.name ?? null,
      draft: (opts.resolveDraftModel ? await opts.resolveDraftModel().catch(() => null) : draftModel)?.kind ?? null },
    repo: { id: repo.id, configured: Boolean(repo.url), baseRef: repo.baseRef, forge: repo.forge },
    signIn: signIn ? { provider: "notorganic", product: config.NOTORGANIC_PRODUCT, approvers: approvers.size } : null,
  });
  const docs = new PolicyDocs({
    git: g, baseRef: repo.baseRef,
    activeContent: async (path) => {
      const reviewed = await activation?.content(path);
      if (reviewed !== undefined && reviewed !== null) return reviewed;
      const run = await setup.current();
      return run?.status === "ready" || run?.investigationActive ? run.artifacts.find((a) => a.path === path)?.content ?? null : null;
    },
    activePaths: () => activation?.paths() ?? Promise.resolve([]),
    ...(config.EPHYRA_AUTONOMY_FILE ? { autonomyFile: config.EPHYRA_AUTONOMY_FILE } : {}),
    ...(config.EPHYRA_THRESHOLDS_FILE ? { thresholdsFile: config.EPHYRA_THRESHOLDS_FILE } : {}),
  });
  const now = () => new Date();
  activation = new PolicyActivation({ git: g, docs, audit, now, apply: async (documents, receipt) => {
    if (documents["autonomy.md"]) Object.assign(autonomy, parseAutonomy(documents["autonomy.md"]));
    if (documents["thresholds.yaml"]) {
      for (const key of Object.keys(thresholds)) delete thresholds[key];
      Object.assign(thresholds, parseThresholds(documents["thresholds.yaml"]));
    }
    // Followers reload policy for reads; only the active worker may invalidate journaled work.
    if (durableStore) {
      try { durableStore.assertOwner(); } catch { return; }
    }
    if (appliedPolicy === receipt.commit) return;
    for (const trail of await ctx.trails.list()) {
      if (["closed", "abandoned"].includes(trail.state) || trail.policyCommit === receipt.commit) continue;
      const files = trail.head ? (await g(["diff", "--name-only", trail.base.sha, trail.head])).split("\n").filter(Boolean)
        : (await Promise.all(trail.signals.map(id => ctx.signals.get(id)))).flatMap(signal => signal?.frames.filter(frame => frame.inApp)
          .map(frame => frame.file) ?? []);
      const rank = { low: 0, medium: 1, high: 2, critical: 3 };
      const area = files.length ? files.map(path => areaFor(autonomy, [path])).sort((a, b) => rank[b.risk] - rank[a.risk])[0]!
        : autonomy.areas.find(candidate => candidate.name === trail.area) ?? autonomy.fallback;
      await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "policy-activation" }, type: "policy_updated",
        data: { commit: receipt.commit, path: receipt.path, risk: area.risk, area: area.name } });
    }
    appliedPolicy = receipt.commit;
  } });
  await activation.restore();
  const drafts = new DraftService({
    store: client ? new ConvexDraftStore(client, secret) : new MemoryDraftStore(), docs, activation, git: g, audit,
    baseRef: repo.baseRef, now, id: randomUUID, log,
    velum: new Velum({ model: draftModel, resolveModel: opts.resolveDraftModel, usage, now, id: randomUUID, secrets: knownSecrets(config) }),
  });
  const consolePort: ConsolePort = {
    usage: usageStore, trails: () => store.listTrails(), activity: (limit) => activity({ store, now }, limit), docs, drafts, now,
    runs: runStore, broker: runBroker, activation,
  };
  const speech = opts.speechProvider ?? (config.EPHYRA_VOICE === "none" ? null : new CompatibleSpeechProvider({
    kind: config.EPHYRA_VOICE, billedTo: config.EPHYRA_VOICE === "notorganic" ? "notorganic" : config.EPHYRA_VOICE_API_KEY ? "byok" : "unknown",
    baseUrl: config.EPHYRA_VOICE === "notorganic" ? new URL("/v1", config.NOTORGANIC_ISSUER).href : config.EPHYRA_VOICE_URL!,
    transcriptionModel: config.EPHYRA_VOICE_STT_MODEL!, speechModel: config.EPHYRA_VOICE_TTS_MODEL!, voice: config.EPHYRA_VOICE_NAME!,
    ...(config.EPHYRA_VOICE === "notorganic" ? { maxCostMicrousd: config.EPHYRA_VOICE_MAX_COST_MICROUSD, fetcher: signIn!.fetch as typeof fetch } : {}),
    headers: async (url): Promise<Record<string, string>> => {
      if (config.EPHYRA_VOICE !== "notorganic") return config.EPHYRA_VOICE_API_KEY ? { authorization: `Bearer ${config.EPHYRA_VOICE_API_KEY}` } : {};
      const creds = await signIn!.credentialsFor(billingDid!);
      return { authorization: `DPoP ${creds.token}`, dpop: await dpopProof(url, creds.token, creds.keys) };
    },
  }));
  const voice = new VoiceService({ speech, model: draftModel, usage, ledger, context: voiceContext(consolePort, port), secrets: knownSecrets(config) });
  const tutorBackend = opts.tutorBackend ?? (config.EPHYRA_TUTOR === "notorganic"
    ? new NotOrganicTutorBackend(signIn!, billingDid!, config.EPHYRA_TUTOR_MAX_COST_MICROUSD)
    : config.EPHYRA_TUTOR === "ampersand" ? new DirectTutorBackend(new AmpersandDraftModel(config.EPHYRA_HUMANS_API_KEY!, ledger, TUTOR_MODEL)) : null);
  const tutor = new TutorService({ backend: tutorBackend, port, ledger, usage, secrets: knownSecrets(config) });
  const api = createApp(
    config.EPHYRA_API_TOKEN, port, ingest,
    signIn ? (token) => signIn!.authenticate(token) : undefined,
    { requireSignIn: Boolean(signIn), approvers, ...(signIn ? { browserOrigin: signIn.config.publicOrigin } : {}) },
    (approval) => consoleRoutes(consolePort, approval).route("/", voiceRoutes(voice))
      .route("/", tutorRoutes(tutor)).route("/", setupRoutes(setup)),
  );
  const mode = client ? "convex" as const : "memory" as const;
  const health = async () => {
    if (!client) return { store: "memory" as const };
    try { await store.inboxList(); return { store: "ok" as const }; } catch { return { store: "unavailable" as const }; }
  };
  const app = new Hono();
  const withOwner = async <T>(work: () => Promise<T>): Promise<T> => {
    if (!durableStore) return work();
    durableStore.assertOwner();
    return durableStore.withOwner(work);
  };
  if (durableStore) app.use("/v1/*", async (c, next) => {
    const readonly = ["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    try {
      durableStore.assertOwner();
    } catch {
      if (readonly) return next();
      c.header("Retry-After", "10");
      return c.json({ error: "The workspace worker is changing ownership. Retry after refreshing." }, 503);
    }
    try { return await durableStore.withOwner(() => next()); }
    catch (error) {
      if (!(error instanceof WorkerOwnershipLost)) throw error;
      c.header("Retry-After", "10");
      return c.json({ error: "The workspace worker changed ownership. Refresh to check the saved outcome." }, 503);
    }
  });
  if (proofReceipts && !opts.workspace) app.route("/", proofReceipts.routes());
  if (opts.ampReports) app.route("/", ampReportRoutes(opts.ampReports));
  app.get("/healthz", async (c) => {
    const h = await health();
    c.header("Cache-Control", "no-store");
    return c.json({ ok: h.store !== "unavailable", mode, ...h, version: VERSION, revision: releaseRevision() }, h.store === "unavailable" ? 503 : 200);
  });
  if (signIn) app.route("/auth", authRoutes(signIn, approvers, opts.setupScopes));
  else app.get("/auth/session", (c) => c.json({ signIn: false, identity: null }, 200, { "Cache-Control": "no-store" }));
  if (hasConsole(config.EPHYRA_CONSOLE_DIR)) app.route("/", consoleStatic(config.EPHYRA_CONSOLE_DIR));
  app.route("/", api);
  let startup: Promise<void> | null = null;
  let generation = 0;
  const start = (): Promise<void> => {
    if (startup) return startup;
    const version = generation;
    startup = (async () => {
      const acquired = async () => {
        if (version !== generation) return;
        await durableStore?.recoverRunning();
        await runStore.closeRunning("the owning worker stopped before this run completed; reconcile external work before retrying", new Date());
        await engine.recoverProjections();
        await activation?.restore();
        await setup.restore();
        await engine.recoverEffects(undefined, { project: false });
        if (repo.url && (!opts.workspace || await setup.current())) await telemetry?.start();
        if (version === generation) { durableStore?.assertOwner(); jobs.start(); }
      };
      if (durableStore) await durableStore.startOwner({ onAcquired: async () => {
        try { await acquired(); }
        catch (error) { log("workspace worker startup recovery failed"); throw error; }
      }, onLost: async () => {
        telemetry?.stop(); jobs.stop();
        const receipts = await control.stopAll();
        if (receipts.some(receipt => ["pending_allocation", "reconciliation_required"].includes(receipt.status))) {
          log("worker cleanup needs reconciliation", { receipts });
          throw new Unverified("Runner cleanup must be reconciled before this worker can resume");
        }
      } });
      else await acquired();
    })().catch((error) => { if (version === generation) startup = null; throw error; });
    return startup;
  };
  if (opts.startJobs !== false) await start();
  log("composed", {
    mode, extract: extract?.alias ?? null, decide: decide?.alias ?? null, agent: agent?.name ?? null, repo: repo.id,
    signIn: Boolean(signIn), approvers: approvers.size, draft: draftModel?.kind ?? null, console: hasConsole(config.EPHYRA_CONSOLE_DIR),
  });
  return { app, decide, signIn, mode, ctx, usage: usageStore, memoryAudit, runs: runStore, runBroker, drafts, draftModel,
    engine, jobs, setup, questions, telemetry, withOwner, health, start,
    close: async () => {
      generation++; telemetry?.stop(); jobs.stop(); startup = null;
      if (durableStore) await durableStore.stopOwner();
      else await control.stopAll();
    } };
}
