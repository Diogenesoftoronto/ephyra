// Composition root: config → stores (Convex or memory) → engine → effect handlers → HTTP app.
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Hono } from "hono";
import {
  systemIds, type Budget, type CodingAgent, type DecideBackend, type Effect, type ExtractBackend, type Runner,
  type ServiceProfile, type SignalStore, type Trail, type TransitionContext,
} from "@ephyra/core";
import { MemorySignalStore, otlpRoutes } from "@ephyra/ingest";
import { GitJournal } from "@ephyra/journal";
import {
  AUTONOMY_TEMPLATE, THRESHOLDS_TEMPLATE, checkpointMode, parseAutonomy, parseThresholds, type AutonomyPolicy,
} from "@ephyra/policy";
import { ParserExtract, SystemOneHttpDecide, TypeSafeDecide, WorkersAiClairicExtract } from "@ephyra/models";
import { LocalRunner } from "@ephyra/runner";
import { AmpAgent, ClaudeCodeAgent, CodexAgent, buildProof, type AmpThreadStore } from "@ephyra/agent";
import { PlainGitAdapter } from "@ephyra/forge";
import { MemoryAudit } from "./audit.ts";
import { approverDids, type Config } from "./config.ts";
import { SecretBox } from "./auth/crypto.ts";
import { HostedDecide, HostedExtract } from "./auth/hosted.ts";
import { NotOrganicSignIn } from "./auth/notorganic.ts";
import { authRoutes } from "./auth/routes.ts";
import { ConvexAuthStore, MemoryAuthStore } from "./auth/store.ts";
import { createApp } from "./http/app.ts";
import { consoleRoutes } from "./http/console.ts";
import { consoleStatic, hasConsole } from "./http/static.ts";
import { activity } from "./activity.ts";
import { ConvexDraftStore, DraftService, MemoryDraftStore } from "./drafts.ts";
import { PolicyDocs } from "./docs.ts";
import { ConvexUsageStore, MemoryUsageStore, UsageRecorder, type BilledTo, type UsageStore } from "./usage.ts";
import {
  AnthropicDraftModel, FakeDraftModel, NotOrganicDraftModel, OpenAiDraftModel, Velum, type DraftModel,
} from "./velum.ts";
import { ConvexAudit, ConvexOperationLedger, ConvexRuntimeStore, ConvexSignalStore, convexClient } from "./convex/stores.ts";
import { MemoryOperationLedger } from "./orchestrator/effects.ts";
import type { EffectHandlers } from "./orchestrator.ts";
import type { RepoConfig, ServerContext } from "./wiring/context.ts";
import { MemoryStore, type RuntimeStore } from "./wiring/store.ts";
import { Engine, JobLoop } from "./wiring/runtime.ts";
import { intake, intakeHandlers } from "./wiring/intake.ts";
import { httpPort, humanHandlers, type AuditSink } from "./wiring/human.ts";
import { agentHandlers, type BuildProofFn } from "./wiring/agents.ts";
import { landingHandlers, type Git } from "./wiring/landing.ts";

export const VERSION = "0.1.0-prealpha";

export type Composed = {
  app: Hono;
  decide: DecideBackend | null;
  signIn: NotOrganicSignIn | null;
  mode: "memory" | "convex";
  ctx: ServerContext;
  usage: UsageStore;
  drafts: DraftService;
  /** The model behind Velum, or null when EPHYRA_DRAFT=none. */
  draftModel: DraftModel | null;
  engine: Engine;
  jobs: JobLoop;
  health(): Promise<{ store: "ok" | "unavailable" | "memory" }>;
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

function git(dir: string): Git {
  return async (args, opts) => {
    const proc = Bun.spawn(["git", "--git-dir", dir, ...args], {
      stdin: opts?.input ? new Blob([opts.input]) : "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...opts?.env },
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
    const blocking = (c: "A" | "B" | "C") => !area || checkpointMode(autonomy, area, c) === "blocking";
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

function agentBilledTo(config: Config): BilledTo {
  if (config.EPHYRA_AGENT === "amp") return config.EPHYRA_AMP_EXECUTOR === "local" ? "local" : "byok";
  return config.EPHYRA_AGENT === "none" ? "unknown" : "local";
}

function agentFor(config: Config, ampThreads: AmpThreadStore): CodingAgent | null {
  if (config.EPHYRA_AGENT === "claude-code") return new ClaudeCodeAgent(config.EPHYRA_AGENT_MODEL ?? "claude-opus-5-5");
  if (config.EPHYRA_AGENT === "codex") return new CodexAgent(config.EPHYRA_AGENT_MODEL ?? "gpt-6.1-sol");
  if (config.EPHYRA_AGENT === "amp") {
    const executor = config.EPHYRA_AMP_EXECUTOR === "orb"
      ? { kind: "orb" as const, ...(config.EPHYRA_AMP_PROJECT ? { project: config.EPHYRA_AMP_PROJECT } : {}) }
      : config.EPHYRA_AMP_EXECUTOR === "runner"
        ? { kind: "runner" as const, runnerId: config.EPHYRA_AMP_RUNNER_ID! }
        : { kind: "local" as const };
    return new AmpAgent({ executor, mode: config.EPHYRA_AMP_MODE, threads: ampThreads });
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

function draftModelFor(config: Config, signIn: NotOrganicSignIn | null, billingDid: string | undefined): DraftModel | null {
  switch (config.EPHYRA_DRAFT) {
    case "notorganic": return signIn && billingDid ? new NotOrganicDraftModel(signIn, billingDid, config.EPHYRA_DRAFT_MODEL) : null;
    case "anthropic": return new AnthropicDraftModel(config.EPHYRA_DRAFT_ANTHROPIC_API_KEY!, config.EPHYRA_DRAFT_MODEL);
    case "openai": return new OpenAiDraftModel(config.EPHYRA_DRAFT_OPENAI_API_KEY!, config.EPHYRA_DRAFT_MODEL);
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
  startJobs?: boolean;
  /** Replaces the fetch used to talk to Not Organic (tests). */
  notOrganicFetch?: import("./auth/crypto.ts").Fetch;
  /** Test/dev injection points. */
  agent?: CodingAgent;
  runner?: Runner;
  decide?: DecideBackend;
  /** Replaces the configured Velum model (tests: nothing here may touch the network). */
  draftModel?: DraftModel;
};

export async function compose(config: Config, opts: ComposeOverrides = {}): Promise<Composed> {
  const log: ServerContext["log"] = (msg, fields) => console.log(JSON.stringify({ msg, ...fields }));
  const client = config.CONVEX_URL ? convexClient({ url: config.CONVEX_URL, secret: config.EPHYRA_CONVEX_SECRET! }) : null;
  const secret = config.EPHYRA_CONVEX_SECRET ?? "";
  const store: RuntimeStore & { recoverRunning?(): Promise<unknown> } = client ? new ConvexRuntimeStore(client, secret) : new MemoryStore();
  const signals: SignalStore = client ? new ConvexSignalStore(client, secret) : new MemorySignalStore();
  const ledger = client ? new ConvexOperationLedger(client, secret) : new MemoryOperationLedger();
  const usageStore: UsageStore = client ? new ConvexUsageStore(client, secret) : new MemoryUsageStore();
  const usage = new UsageRecorder(usageStore, log);
  const memoryAudit = new MemoryAudit();
  const audit: AuditSink = client ? new ConvexAudit(client, secret) : { append: async (i) => memoryAudit.append(i) };

  const repo: RepoConfig = {
    id: config.EPHYRA_REPO_ID, url: config.EPHYRA_REPO_URL ?? "", mirrorDir: join(config.EPHYRA_DATA_DIR, "workspace.git"),
    baseRef: config.EPHYRA_BASE_REF, forge: config.EPHYRA_FORGE, remote: "origin",
  };
  await prepareWorkspace(repo, log);
  const autonomy = parseAutonomy(await readOptional(config.EPHYRA_AUTONOMY_FILE, AUTONOMY_TEMPLATE));
  const thresholds = parseThresholds(await readOptional(config.EPHYRA_THRESHOLDS_FILE, THRESHOLDS_TEMPLATE));
  const journal = new GitJournal({ gitDir: repo.mirrorDir, clock: { now: () => new Date() } });
  const jobs = new JobLoop(store, log);
  const engine = new Engine(store, journal, ledger, contextFn(autonomy), systemIds, log);

  const ctx: ServerContext = {
    repo, policy: { autonomy, thresholds }, journal, signals, clock: { now: () => new Date() }, ids: systemIds, log,
    inbox: {
      put: (item) => store.inboxPut(item), remove: (id) => store.inboxRemove(id),
      get: (id) => store.inboxGet(id), list: () => store.inboxList(),
    },
    jobs: { register: (k, r) => jobs.register(k, r), enqueue: (k, key, p, o) => jobs.enqueue(k, key, p, o) },
    emit: async (input) => { await engine.emit(input); },
    start: (trail, initial, effects) => engine.start(trail, initial, effects ?? []),
    trails: {
      get: (id) => store.getTrail(id), list: (f) => store.listTrails(f?.states), events: (id) => store.events(id),
    },
  };

  const g = git(repo.mirrorDir);
  const budget: Budget = { tokensUsed: 0, tokensMax: 2_000_000, wallclockMaxS: 4 * 3600, spendMicrousdUsed: 0, spendMicrousdMax: 0 };
  const approvers = new Set(approverDids(config));
  let signIn: NotOrganicSignIn | null = null;
  if (config.EPHYRA_PUBLIC_ORIGIN && config.EPHYRA_SESSION_KEY) {
    signIn = new NotOrganicSignIn(
      {
        issuer: config.NOTORGANIC_ISSUER, authorizationUrl: config.NOTORGANIC_AUTHORIZATION_URL,
        publicOrigin: config.EPHYRA_PUBLIC_ORIGIN, product: config.NOTORGANIC_PRODUCT,
        scopes: [
          "wallet:read", "usage:read", "judgement:evaluate", "extraction:run",
          // Velum on Not Organic chat needs the model's inference scope; asked for only when it is in use.
          ...(config.EPHYRA_DRAFT === "notorganic" ? [`infer:${config.EPHYRA_DRAFT_MODEL ?? "balanced"}`] : []),
        ],
      },
      client ? new ConvexAuthStore(client, secret) : new MemoryAuthStore(),
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
  const draftModel = opts.draftModel ?? draftModelFor(config, signIn, billingDid);
  const profile: ServiceProfile = {
    name: "local", digest: "local", network: "egress", readOnlyProd: true, credentials: [],
    limits: { cpu: 2, memoryMb: 4096, diskMb: 8192, timeoutS: config.EPHYRA_STEP_TIMEOUT_S },
  };
  const agent = opts.agent ?? agentFor(config, ampThreadsFrom(store));
  const runner: Runner | null = opts.runner
    ?? (agent ? new LocalRunner(join(config.EPHYRA_DATA_DIR, "runner"), { trusted: true, allowDevenv: false }) : null);
  const intakeHooks = intake(ctx, {
    extract, decide, budget,
    baseSha: async () => (await g(["rev-parse", repo.baseRef])).trim(),
  });
  const slices = [
    intakeHandlers(ctx),
    humanHandlers(ctx),
    agentHandlers(ctx, { runner, agent, profile, buildProof: buildProof as unknown as BuildProofFn, stepTimeoutS: config.EPHYRA_STEP_TIMEOUT_S,
      usage, agentBilledTo: agentBilledTo(config) }),
    landingHandlers(ctx, {
      adapters: [new PlainGitAdapter(repo.mirrorDir, undefined, repo.id, repo.mirrorDir, ledger)],
      git: g, watchEveryMs: config.EPHYRA_WATCH_EVERY_S * 1000,
    }),
  ];
  const handlers = Object.fromEntries(ALL_EFFECTS.map((t) => [t, notWired(t)])) as unknown as EffectHandlers;
  for (const slice of slices) Object.assign(handlers, slice);
  engine.setHandlers(handlers);

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
    reconciliations: client ? await (ledger as ConvexOperationLedger).reconciliations() : engine.reconciliations,
    backends: { extract: extract?.alias ?? null, decide: decide?.alias ?? null, agent: agent?.name ?? null, draft: draftModel?.kind ?? null },
    repo: { id: repo.id, configured: Boolean(repo.url), baseRef: repo.baseRef, forge: repo.forge },
    signIn: signIn ? { provider: "notorganic", product: config.NOTORGANIC_PRODUCT, approvers: approvers.size } : null,
  });
  const docs = new PolicyDocs({
    git: g, baseRef: repo.baseRef,
    ...(config.EPHYRA_AUTONOMY_FILE ? { autonomyFile: config.EPHYRA_AUTONOMY_FILE } : {}),
    ...(config.EPHYRA_THRESHOLDS_FILE ? { thresholdsFile: config.EPHYRA_THRESHOLDS_FILE } : {}),
  });
  const now = () => new Date();
  const drafts = new DraftService({
    store: client ? new ConvexDraftStore(client, secret) : new MemoryDraftStore(), docs, git: g, audit, baseRef: repo.baseRef, now, id: randomUUID, log,
    velum: new Velum({ model: draftModel, usage, now, id: randomUUID }),
  });
  const api = createApp(
    config.EPHYRA_API_TOKEN, port, ingest,
    signIn ? (token) => signIn!.authenticate(token) : undefined,
    { requireSignIn: Boolean(signIn), approvers },
    (approval) => consoleRoutes({
      usage: usageStore, trails: () => store.listTrails(), activity: (limit) => activity({ store, now }, limit), docs, drafts, now,
    }, approval),
  );
  const mode = client ? "convex" as const : "memory" as const;
  const health = async () => {
    if (!client) return { store: "memory" as const };
    try { await store.inboxList(); return { store: "ok" as const }; } catch { return { store: "unavailable" as const }; }
  };
  const app = new Hono();
  app.get("/healthz", async (c) => {
    const h = await health();
    return c.json({ ok: h.store !== "unavailable", mode, ...h, version: VERSION }, h.store === "unavailable" ? 503 : 200);
  });
  if (signIn) app.route("/auth", authRoutes(signIn, approvers));
  if (hasConsole(config.EPHYRA_CONSOLE_DIR)) app.route("/", consoleStatic(config.EPHYRA_CONSOLE_DIR));
  app.route("/", api);

  if (opts.startJobs !== false) {
    await store.recoverRunning?.();
    jobs.start();
  }
  log("composed", {
    mode, extract: extract?.alias ?? null, decide: decide?.alias ?? null, agent: agent?.name ?? null, repo: repo.id,
    signIn: Boolean(signIn), approvers: approvers.size, draft: draftModel?.kind ?? null, console: hasConsole(config.EPHYRA_CONSOLE_DIR),
  });
  return { app, decide, signIn, mode, ctx, usage: usageStore, drafts, draftModel, engine, jobs, health, close: async () => { jobs.stop(); } };
}
