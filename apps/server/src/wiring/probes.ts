import { z } from "zod";
import {
  ProofBundle, ProofItem, ReconciliationRequired, Unverified, canonicalJson, proofDigest, sha256Hex,
  type Journal, type OperationLedger, type Runner, type RunnerHandle, type Signal, type Trail,
} from "@ephyra/core";
import { redact } from "@ephyra/agent";
import { JournalConflict } from "@ephyra/journal";
import type { Git } from "./landing.ts";
import type { HandlerSlice, ServerContext } from "./context.ts";
import { recordTrailUsage } from "./budget.ts";
import type { BoundProofEvidence } from "./verification.ts";

const MAX_DOCUMENT = 256_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,179}$/;
const safePath = (path: string) => path.length > 0 && path.length <= 500 && !path.startsWith("/")
  && !path.split("/").some(part => part === ".." || part === "." || !part) && !/[\x00-\x1f\\]/.test(path);
const digest = (value: unknown) => `sha256:${sha256Hex(canonicalJson(value))}`;
const argv = z.array(z.string().min(1).max(4000).refine(value => !value.includes("\0"))).min(1).max(100);
const Source = z.object({ commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), path: z.string().refine(safePath),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), trailId: z.string().uuid().optional(), proofDigest: z.string().optional(),
  journalCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),
  harnessCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional() });
const Definition = z.object({ id: z.string().regex(ID), kind: z.enum(["intent", "regression"]),
  paths: z.array(z.string().min(1).max(500)).max(100), area: z.string().max(100).optional(),
  command: argv.optional(), script: z.string().min(1).max(MAX_DOCUMENT).optional(),
  protectedPaths: z.array(z.string().min(1).max(500)).max(200).optional(),
  unavailable: z.string().max(300).optional(), source: Source });
export type ProbeDefinition = z.infer<typeof Definition>;
export type ProbeReceipt = {
  id: string; kind: ProbeDefinition["kind"]; result: "pass" | "fail"; exit: number; log: string;
  source: ProbeDefinition["source"]; at: string;
};
export type ProbeExecution = {
  runner: Runner; handle: RunnerHandle; cwd?: string; remainingMs(): number; secrets?: string[];
};

export type HarnessDeclaration = {
  command?: string[]; script?: string; protectedPaths?: string[]; sourcePath?: string;
};
const patternOk = (value: string) => safePath(value) && !value.startsWith(":") && !value.startsWith("-");

/** Only immutable shell predicates/builtins can omit a verifier dependency manifest. No eval, sourcing or expansion. */
export function selfContainedShell(body: string): boolean {
  if (!body.trim() || /[$`<>(){}]/.test(body)) return false;
  const parts = body.split(/&&|\|\||;|\r?\n/).map(part => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(part => !/[|&]/.test(part)
    && /^(?:test|\[|true|false|exit|printf|echo)(?:\s|$)/.test(part));
}

function inlineShell(declaration: HarnessDeclaration): string | undefined {
  if (declaration.script !== undefined) return declaration.script;
  const command = declaration.command;
  return command?.length === 3 && ["sh", "bash"].includes(command[0]!) && command[1] === "-c" ? command[2] : undefined;
}

/** Literal script/config argv paths are protected even when a manifest accidentally leaves the entrypoint out. */
export function harnessPaths(declaration: HarnessDeclaration, requireDeclaration = false): { patterns: string[]; direct: string[] } {
  const inline = inlineShell(declaration);
  if ((requireDeclaration || inline === undefined || !selfContainedShell(inline)) && !declaration.protectedPaths?.length) {
    throw new Unverified("protectedPaths must declare the accepted verifier dependency closure");
  }
  const protectedPaths = declaration.protectedPaths ?? [];
  if (protectedPaths.length > 200 || protectedPaths.some(path => !patternOk(path))) throw new Unverified("protected verifier path declaration");
  if (declaration.sourcePath && !safePath(declaration.sourcePath)) throw new Unverified("verifier configuration source path");
  const direct: string[] = [];
  const executable = declaration.command?.[0]?.split("/").at(-1);
  for (const [index, raw] of (declaration.command ?? []).entries()) {
    if (inline !== undefined && index === 2) continue;
    const path = raw.startsWith("--") && raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw;
    if (path.startsWith("-") || /\s/.test(path)) continue;
    if (path.startsWith("/")) {
      if (index === 0 && /^\/(?:usr\/(?:local\/)?bin|bin)\/[a-zA-Z0-9._-]+$/.test(path)) continue;
      throw new Unverified("repository verifier argv must use relative paths");
    }
    const bareScript = index === 1 && ["sh", "bash", "dash", "node", "python", "python3", "ruby", "perl", "lua", "tsx", "ts-node"]
      .includes(executable ?? "") || index === 1 && executable === "bun" && !["run", "test", "install", "build", "exec", "x"].includes(path);
    if (bareScript || path.includes("/") || /\.(?:[cm]?[jt]sx?|sh|py|rb|lua|json|ya?ml|toml|nix)$/.test(path)) {
      const normalized = path.replace(/^\.\//, "");
      if (!safePath(normalized) || /[*?\[\]{}]/.test(normalized)) throw new Unverified("literal verifier argv path");
      direct.push(normalized);
    }
  }
  const packageMetadata = ["bun", "npm", "pnpm", "yarn", "npx"].includes(executable ?? "") && inline === undefined ? ["package.json"] : [];
  const patterns = [...new Set([...protectedPaths, ...direct, ...packageMetadata, ...(declaration.sourcePath ? [declaration.sourcePath] : [])])];
  return { patterns, direct: [...new Set(direct)] };
}

export function assertHarnessUnchanged(declaration: HarnessDeclaration, changed: string[], requireDeclaration = false): void {
  const { patterns } = harnessPaths(declaration, requireDeclaration);
  if (changed.some(path => patterns.some(pattern => new Bun.Glob(pattern).match(path)))) {
    throw new Unverified("candidate changed the accepted verifier dependency closure; approve harness changes separately");
  }
}

/** Check the actual execution tree as well as its commit: test/install hooks cannot rewrite a trusted reporter before it runs. */
export async function assertRuntimeHarness(execution: ProbeExecution, base: string, declaration: HarnessDeclaration,
  requireDeclaration = false): Promise<void> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(base)) throw new Unverified("accepted verifier base commit");
  const read = async (args: string[]) => {
    let output = "", exit: number | undefined;
    for await (const part of execution.runner.exec(execution.handle, ["git", ...args], {
      cwd: execution.cwd, deadlineMs: execution.remainingMs(),
    })) {
      if ("chunk" in part) {
        if (part.stream === "stdout") output += part.chunk;
        if (output.length > MAX_DOCUMENT) throw new Unverified("verifier integrity output limit");
      } else {
        if (exit !== undefined || part.timedOut) throw new Unverified("verifier integrity process outcome");
        exit = part.exit;
      }
    }
    if (exit !== 0) throw new Unverified("verifier integrity Git operation");
    return output.split("\0").filter(Boolean);
  };
  const { direct, patterns } = harnessPaths(declaration, requireDeclaration);
  const accepted = direct.length ? await read(["ls-tree", "-r", "--name-only", "-z", base, "--", ...direct]) : [];
  if (direct.some(path => !accepted.includes(path))) throw new Unverified("verifier argv path was not present at the accepted base");
  const changed = await read(["diff", "--no-ext-diff", "--name-only", "-z", base, "--"]);
  const added = await read(["ls-files", "--others", "--exclude-standard", "-z"]);
  const ignored = patterns.length ? await read(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...patterns]) : [];
  assertHarnessUnchanged(declaration, [...changed, ...added, ...ignored], requireDeclaration);
  execution.remainingMs();
}

/** Repository code only runs inside the caller's authorized isolated execution environment. */
export async function executeProbe(probe: ProbeDefinition, execution: ProbeExecution): Promise<ProbeReceipt> {
  const parsed = Definition.parse(probe);
  if (parsed.unavailable || (!parsed.command && !parsed.script)) throw new Unverified(parsed.unavailable ?? "probe command");
  const { runner, handle, cwd, remainingMs, secrets } = execution;
  if (parsed.kind === "intent") {
    await assertRuntimeHarness(execution, parsed.source.harnessCommit ?? parsed.source.commit, {
      command: parsed.command, script: parsed.script, protectedPaths: parsed.protectedPaths, sourcePath: parsed.source.path,
    });
  }
  let command = parsed.command;
  if (parsed.script) {
    const name = `.ephyra-probe-${sha256Hex(parsed.id).slice(0, 24)}.sh`;
    if (cwd && !safePath(cwd)) throw new Unverified("probe worktree path");
    await runner.writeFile(handle, cwd ? `${cwd}/${name}` : name, parsed.script);
    command = ["sh", name];
  }
  let exit: number | undefined;
  let output = "";
  for await (const part of runner.exec(handle, command!, { ...(cwd ? { cwd } : {}), deadlineMs: remainingMs() })) {
    if ("chunk" in part) {
      output += part.chunk;
      if (output.length > MAX_DOCUMENT) throw new Unverified("probe output limit");
    } else {
      if (exit !== undefined || part.timedOut || !Number.isInteger(part.exit) || part.exit < 0) {
        throw new Unverified("complete probe process receipt");
      }
      exit = part.exit;
    }
  }
  remainingMs();
  if (exit === undefined) throw new Unverified("probe process outcome");
  return { id: parsed.id, kind: parsed.kind, result: exit === 0 ? "pass" : "fail", exit,
    log: redact(output, secrets, MAX_DOCUMENT), source: parsed.source, at: new Date().toISOString() };
}

/** Area and touched-file selection never broadens a declared source into another area's authority. */
export function probeApplies(probe: Pick<ProbeDefinition, "area" | "paths">, area: string, files: string[]): boolean {
  if (probe.area && probe.area !== area) return false;
  if (!probe.paths.length) return true;
  return files.some(file => probe.paths.some(pattern => new Bun.Glob(pattern).match(file)));
}

export type ProbeCatalogOptions = {
  git: Git; journal: Journal; secrets?: string[]; maxProbes?: number;
  /** Explicitly reviewed policy documents can override intents independently of an application deployment. */
  intentDocuments?: (trail: Trail) => Promise<Array<{ path: string; content: string; commit: string }>>;
};

/** Successful repros are immutable Git records. An interrupted registration can safely compare the same ref on restart. */
export class GitProbeCatalog {
  constructor(private readonly options: ProbeCatalogOptions) {}

  private bounded(text: string): string {
    if (Buffer.byteLength(text) > MAX_DOCUMENT) throw new Unverified("bounded probe source");
    return text;
  }

  async registerClosedTrail(trail: Trail): Promise<ProbeDefinition> {
    const snapshot = await this.options.journal.read(trail.id);
    if (!snapshot || snapshot.trail.state !== "closed" || snapshot.trail.rev !== trail.rev || snapshot.trail.head !== trail.head) {
      throw new Unverified("only the exact closed trail can register a regression probe");
    }
    const bytes = await this.options.journal.readFile(trail.id, "proof/manifest.json");
    if (!bytes || bytes.byteLength > MAX_DOCUMENT) throw new Unverified("closed trail proof manifest");
    const proof = ProofBundle.parse(JSON.parse(new TextDecoder().decode(bytes)));
    const event = [...snapshot.events].reverse().find(item => item.type === "proof_completed" && item.data.bundle.rev === trail.rev);
    if (!proof.passed || proof.missing.length || proof.trail !== trail.id || proof.rev !== trail.rev || proof.head !== trail.head
      || proof.base !== trail.base.sha || event?.type !== "proof_completed" || event.data.digest !== proofDigest(proof)) {
      throw new Unverified("closed regression proof binding");
    }
    const before = proof.items.find(item => item.kind === "repro_before");
    const after = proof.items.find(item => item.kind === "repro_after");
    const scope = proof.items.find(item => item.kind === "diff_scope");
    if (!before || !after || before.probe !== after.probe || !scope?.paths.length || !safePath(after.probe)) {
      throw new Unverified("closed trail observed repro and file scope");
    }
    // Read the script as it stood when the successful proof event was first journaled, never a later mutable path.
    const journalCommit = (await this.options.git(["log", "-1", "--format=%H", "--diff-filter=A",
      `refs/ephyra/trails/${trail.id}/journal`, "--", `events/${event.id}.json`])).trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(journalCommit)) throw new Unverified("proof journal source commit");
    const script = this.bounded(await this.options.git(["show", `${journalCommit}:${after.probe}`]));
    if (!script.length) throw new Unverified("regression probe script");
    if (redact(script, this.options.secrets, MAX_DOCUMENT) !== script) throw new Unverified("regression script contains credentials");
    const definition = Definition.parse({ id: `regression:${trail.id}:${trail.rev}`, kind: "regression", area: trail.area,
      paths: scope.paths, script, source: { commit: proof.head, path: after.probe, digest: digest(script),
        trailId: trail.id, proofDigest: proofDigest(proof), journalCommit } });
    const ref = `refs/ephyra/probes/regression/${trail.id}/${String(trail.rev).padStart(6, "0")}`;
    const content = canonicalJson(definition);
    const existing = await this.options.git(["for-each-ref", "--format=%(refname)", ref]);
    if (existing.trim()) {
      if ((await this.options.git(["show", `${ref}:probe.json`])).trim() !== content) {
        throw new Unverified("immutable regression registration conflict");
      }
      return definition;
    }
    const blob = (await this.options.git(["hash-object", "-w", "--stdin"], { input: content })).trim();
    const tree = (await this.options.git(["mktree"], { input: `100644 blob ${blob}\tprobe.json\n` })).trim();
    const env = { GIT_AUTHOR_NAME: "Ephyra", GIT_AUTHOR_EMAIL: "probe@ephyra.invalid",
      GIT_COMMITTER_NAME: "Ephyra", GIT_COMMITTER_EMAIL: "probe@ephyra.invalid" };
    const commit = (await this.options.git(["commit-tree", tree], {
      input: `Register observed regression ${trail.id} revision ${trail.rev}\n`, env,
    })).trim();
    try { await this.options.git(["update-ref", ref, commit, "0".repeat(commit.length)]); }
    catch {
      if ((await this.options.git(["show", `${ref}:probe.json`])).trim() !== content) {
        throw new Unverified("regression registration outcome");
      }
    }
    return definition;
  }

  async list(trail: Trail, kind?: ProbeDefinition["kind"]): Promise<ProbeDefinition[]> {
    // Candidate patches cannot redefine the product requirement they are being judged against.
    const commit = trail.base.sha;
    const files = trail.head
      ? (await this.options.git(["diff", "--name-only", "-z", trail.base.sha, trail.head])).split("\0").filter(Boolean) : [];
    const probes: ProbeDefinition[] = [];
    if (kind !== "intent") {
      const refs = (await this.options.git(["for-each-ref", "--format=%(refname)", "refs/ephyra/probes/regression/"]))
        .split("\n").filter(Boolean);
      if (refs.length > 1000) throw new Unverified("regression catalog limit");
      for (const ref of refs) {
        if (!/^refs\/ephyra\/probes\/regression\/[a-f0-9-]{36}\/\d{6}$/.test(ref)) throw new Unverified("regression ref identity");
        const probe = Definition.parse(JSON.parse(this.bounded(await this.options.git(["show", `${ref}:probe.json`]))));
        if (probe.kind !== "regression" || !probe.source.trailId || !probe.source.proofDigest || !probe.source.journalCommit || !probe.script
          || digest(probe.script) !== probe.source.digest) throw new Unverified("regression source integrity");
        const original = this.bounded(await this.options.git(["show", `${probe.source.journalCommit}:${probe.source.path}`]));
        if (digest(original) !== probe.source.digest) throw new Unverified("regression proof source changed");
        probes.push(probe);
      }
    }
    if (kind !== "regression") {
      const paths = (await this.options.git(["ls-tree", "-r", "--name-only", commit, "--", "intents/"]))
        .split("\n").filter(path => /^intents\/[a-zA-Z0-9._-]+\.md$/.test(path));
      const active = await this.options.intentDocuments?.(trail) ?? [];
      const documents = new Map<string, { content?: string; commit: string }>(paths.map(path => [path, { commit }]));
      for (const document of active) {
        if (!/^intents\/[a-zA-Z0-9._-]+\.md$/.test(document.path)
          || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(document.commit)) throw new Unverified("active intent source");
        documents.set(document.path, document);
      }
      if (documents.size > 100) throw new Unverified("intent catalog limit");
      for (const [path, document] of documents) {
        const text = this.bounded(document.content ?? await this.options.git(["show", `${document.commit}:${path}`]));
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
        if (frontmatter === undefined) continue;
        const raw = Bun.YAML.parse(frontmatter) as Record<string, unknown>;
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.probes)) throw new Unverified("intent probe frontmatter");
        if (typeof raw.id !== "string" || !ID.test(raw.id) || raw.probes.length > 50) throw new Unverified("intent identity and bounds");
        for (const [index, value] of raw.probes.entries()) {
          if (!value || typeof value !== "object") throw new Unverified("intent probe definition");
          const spec = value as Record<string, unknown>;
          const command = spec.kind === "script" ? spec.command
            ?? (typeof spec.run === "string" ? ["sh", "-c", spec.run] : undefined) : undefined;
          const protectedPaths = spec.protectedPaths ?? raw.protectedPaths;
          if (command) assertHarnessUnchanged({ command: argv.parse(command), protectedPaths:
            protectedPaths === undefined ? undefined : z.array(z.string()).max(200).parse(protectedPaths), sourcePath: path }, files);
          probes.push(Definition.parse({ id: `intent:${raw.id}:${spec.id ?? index}`, kind: "intent",
            paths: raw.paths ?? [], area: raw.area, command, protectedPaths,
            ...(!command ? { unavailable: `intent ${String(spec.kind).slice(0, 60)} probe needs an execution adapter` } : {}),
            source: { commit: document.commit, path, digest: digest(text), harnessCommit: trail.base.sha } }));
        }
      }
    }
    const selected = probes.filter(probe => probeApplies(probe, trail.area, files));
    if (selected.length > (this.options.maxProbes ?? 100) || new Set(selected.map(probe => probe.id)).size !== selected.length) {
      throw new Unverified("probe catalog bounds or duplicate identity");
    }
    return selected.sort((a, b) => a.id.localeCompare(b.id));
  }
}

export type ProbeHandlerDeps = {
  catalog: Pick<GitProbeCatalog, "list" | "registerClosedTrail">;
  ledger: OperationLedger;
  run?: (probe: ProbeDefinition, trail: Trail, operationKey: string) => Promise<ProbeReceipt>;
  onSignal?: (signal: Signal) => Promise<void>;
  respondents?: (request: { trail: Trail; purpose: string; maxMicrousd: number; operationKey: string }) => Promise<{
    trailId: string; rev: number; head: string; item: Extract<z.infer<typeof ProofItem>, { kind: "voxq_study" }>;
  }>;
  secrets?: string[];
};

const StudyRecord = z.object({ schema: z.literal(1), status: z.enum(["completed", "over_limit"]),
  trailId: z.string().uuid(), rev: z.number().int().positive(), base: z.string(), head: z.string(),
  operationKey: z.string().min(1).max(1000), purpose: z.string(), approvedBy: z.string().min(1),
  item: ProofItem, usage: z.object({ tokens: z.literal(0), costMicrousd: z.number().int().nonnegative(),
    wallMs: z.number().int().nonnegative() }) }).refine(value => value.item.kind === "voxq_study"
      && value.item.respondents > 0 && value.item.study.trim().length > 0 && value.item.runId.trim().length > 0
      && value.item.spendMicrousd === value.usage.costMicrousd);
const StudyIndex = z.array(z.object({ path: z.string().regex(/^evidence\/respondents\/[a-f0-9]{64}\.json$/),
  operationKey: z.string().min(1).max(1000), trailId: z.string().uuid(), rev: z.number().int().positive(),
  base: z.string(), head: z.string() }).refine(entry => entry.operationKey.startsWith("respondents:")
    && entry.path === `evidence/respondents/${sha256Hex(entry.operationKey.slice("respondents:".length))}.json`)).max(100);

/** Read only the control plane's authorized dispatch index, never evidence-shaped files supplied by a repository reporter. */
export async function recordedRespondentEvidence(journal: Journal,
  context: { trail: Trail; base: string; head: string }): Promise<BoundProofEvidence[]> {
  const bytes = await journal.readFile(context.trail.id, "evidence/respondents/index.json");
  if (!bytes) return [];
  if (bytes.byteLength > MAX_DOCUMENT) throw new Unverified("respondent evidence index size");
  const index = StudyIndex.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const evidence: BoundProofEvidence[] = [];
  for (const entry of index.filter(item => item.trailId === context.trail.id && item.rev === context.trail.rev
    && item.base === context.base && item.head === context.head)) {
    const raw = await journal.readFile(context.trail.id, entry.path);
    if (!raw || raw.byteLength > MAX_DOCUMENT) throw new Unverified("recorded respondent proof receipt");
    const record = StudyRecord.parse(JSON.parse(new TextDecoder().decode(raw)));
    if (record.status !== "completed" || record.trailId !== entry.trailId || record.rev !== entry.rev
      || record.base !== entry.base || record.head !== entry.head || record.operationKey !== entry.operationKey) {
      throw new Unverified("recorded respondent exact proof binding");
    }
    evidence.push({ trailId: record.trailId, rev: record.rev, base: record.base, head: record.head,
      operationKey: record.operationKey, source: "configured-authorized-respondent-port", items: [record.item] });
  }
  return evidence;
}

async function journalFiles(ctx: ServerContext, trailId: string,
  files: Record<string, string> | (() => Promise<Record<string, string>>)): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await ctx.journal.read(trailId);
    if (!current) throw new Unverified("probe trail journal");
    const additions = typeof files === "function" ? await files() : files;
    try { await ctx.journal.append(trailId, current.head, current.trail, [], additions); return; }
    catch (error) { if (!(error instanceof JournalConflict)) throw error; }
  }
  throw new Unverified("probe evidence journal contention");
}

async function park(ctx: ServerContext, trail: Trail, reason: string): Promise<void> {
  const current = await ctx.trails.get(trail.id);
  if (!current || ["closed", "abandoned", "parked", "handed_off"].includes(current.state)) return;
  await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "probes" }, type: "parked", data: { reason } });
}

async function reserveStudy(ctx: ServerContext, trail: Trail, operationKey: string, ceiling: number): Promise<boolean> {
  let allowed = false;
  await journalFiles(ctx, trail.id, async (): Promise<Record<string, string>> => {
    allowed = false;
    const current = await ctx.journal.read(trail.id);
    if (!current || current.trail.rev !== trail.rev || current.trail.head !== trail.head || current.trail.base.sha !== trail.base.sha) return {};
    const raw = await ctx.journal.readFile(trail.id, "operations/respondents-reservation.json");
    const reservation = raw ? z.object({ operationKey: z.string(), status: z.enum(["pending", "completed"]) })
      .parse(JSON.parse(new TextDecoder().decode(raw))) : null;
    if (reservation?.status === "pending" && reservation.operationKey !== operationKey) return {};
    if ((current.trail.budget.unknownCostEntries ?? 0) > 0
      || ceiling > current.trail.budget.spendMicrousdMax - current.trail.budget.spendMicrousdUsed) return {};
    allowed = true;
    return { "operations/respondents-reservation.json": canonicalJson({ operationKey, status: "pending", ceiling,
      rev: trail.rev, base: trail.base.sha, head: trail.head }) };
  });
  return allowed;
}

async function releaseStudy(ctx: ServerContext, trailId: string, operationKey: string): Promise<void> {
  await journalFiles(ctx, trailId, async (): Promise<Record<string, string>> => {
    const raw = await ctx.journal.readFile(trailId, "operations/respondents-reservation.json");
    const current = raw ? JSON.parse(new TextDecoder().decode(raw)) as { operationKey?: string } : null;
    if (current?.operationKey !== operationKey) return {};
    return { "operations/respondents-reservation.json": canonicalJson({ ...current, status: "completed" }) };
  });
}

/** Every effect now has an inspectable, durable result. Missing paid integrations park without dispatching. */
export function probeHandlers(ctx: ServerContext, deps: ProbeHandlerDeps): HandlerSlice {
  return {
    register_regression_probe: async (_effect, trail) => { await deps.catalog.registerClosedTrail(trail); },
    run_probes: async (effect, trail) => {
      const all = await deps.catalog.list(trail);
      const selected = all.filter(probe => effect.probes.includes(probe.id) || effect.probes.includes(probe.source.path)
        || effect.probes.some(id => probe.id.startsWith(`intent:${id}:`)));
      if (!selected.length || !deps.run) return park(ctx, trail, "Requested probes need configured executable definitions and an isolated runner.");
      const receipts: ProbeReceipt[] = [];
      for (const probe of selected) {
        try { receipts.push(await deps.run(probe, trail, `${effect.key}:${probe.id}`)); }
        catch (error) {
          if (!(error instanceof Unverified)) throw error;
          await journalFiles(ctx, trail.id, { [`probes/runs/${sha256Hex(effect.key)}.json`]: canonicalJson({
            status: "unavailable", probe: probe.id, receipts, reason: redact(error.message, deps.secrets, 1000),
          }) });
          return park(ctx, trail, "The requested probe could not produce a verified execution receipt. Inspect probes/runs.");
        }
      }
      await journalFiles(ctx, trail.id, { [`probes/runs/${sha256Hex(effect.key)}.json`]: canonicalJson(receipts) });
      for (const receipt of receipts.filter(item => item.result === "fail")) {
        const id = sha256Hex(`${effect.key}:${receipt.id}`);
        const signal = { schema: 1 as const, id: `${id.slice(0, 8)}-${id.slice(8, 12)}-5${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}`,
          kind: receipt.kind === "intent" ? "intent_probe" as const : "regression_replay" as const, repo: trail.repo,
          environment: "sandbox", fingerprint: `probe:${sha256Hex(receipt.id)}`, title: `Probe failed: ${receipt.id}`.slice(0, 300),
          message: redact(receipt.log, deps.secrets, 8000), frames: [], firstSeen: receipt.at, lastSeen: receipt.at, count: 1,
          attributes: { probe: receipt.id, commit: trail.head ?? trail.base.sha, sourceDigest: receipt.source.digest }, source: `probe:${receipt.id}` };
        const stored = await ctx.signals.upsert(signal);
        if (stored.isNew) await deps.onSignal?.(stored.signal);
      }
    },
    deliver_child_evidence: async (effect, trail) => {
      const child = await ctx.journal.read(effect.child);
      const bytes = child && await ctx.journal.readFile(effect.child, "proof/manifest.json");
      if (!child || child.trail.parent !== trail.id || child.trail.repo !== trail.repo || child.trail.state !== "closed"
        || !bytes || bytes.byteLength > MAX_DOCUMENT) throw new Unverified("finished child authority and proof");
      const proof = ProofBundle.parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (!proof.passed || proof.missing.length || proof.trail !== child.trail.id || proof.rev !== child.trail.rev
        || proof.head !== child.trail.head || proof.base !== child.trail.base.sha || proofDigest(proof) !== effect.proofDigest) {
        throw new Unverified("child proof exact revision and digest");
      }
      const path = `evidence/children/${effect.child}-${proof.rev}.json`;
      await journalFiles(ctx, trail.id, async () => {
        const bytes = await ctx.journal.readFile(trail.id, "evidence/children/index.json");
        const entry = z.object({ child: z.string().uuid(), rev: z.number().int().positive(),
          path: z.string().refine(safePath), proofDigest: z.string(), base: z.string(), head: z.string() })
          .refine(item => item.path === `evidence/children/${item.child}-${item.rev}.json`);
        const index = bytes ? z.array(entry).max(100).parse(JSON.parse(new TextDecoder().decode(bytes))) : [];
        const next = index.filter(item => item.child !== effect.child);
        next.push({ child: effect.child, rev: proof.rev, path, proofDigest: effect.proofDigest, base: proof.base, head: proof.head });
        if (next.length > 100) throw new Unverified("child evidence index bound");
        return { [path]: canonicalJson({ schema: 1, child: effect.child, rev: proof.rev, proofDigest: effect.proofDigest, proof }),
          "evidence/children/index.json": canonicalJson(next) };
      });
    },
    start_respondent_run: async (effect, trail) => {
      const approved = [...trail.checkpoints.spend].reverse().find(item => !item.shadow && item.verdict === "approve");
      if (!approved || !approved.who || !deps.respondents) {
        return park(ctx, trail, "A named spend approval and configured respondent provider are required before a human study can run.");
      }
      if (!trail.head) return park(ctx, trail, "Pin the exact candidate revision before starting a paid respondent study.");
      if (!Number.isSafeInteger(effect.microusd) || effect.microusd <= 0) throw new Unverified("positive respondent spending authorization");
      const key = `respondents:${effect.key}`;
      const claim = await deps.ledger.begin(key, digest({ trail: trail.id, rev: trail.rev, head: trail.head,
        purpose: effect.purpose, microusd: effect.microusd, approved }));
      if (!claim.fresh && claim.record.status !== "done") throw new ReconciliationRequired(key, "Respondent study outcome is uncertain.");
      let result: z.infer<typeof StudyRecord>;
      if (claim.fresh) {
        const current = await ctx.trails.get(trail.id);
        if (!current || current.rev !== trail.rev || current.head !== trail.head || current.base.sha !== trail.base.sha
          || ["closed", "abandoned", "handed_off"].includes(current.state)) {
          await deps.ledger.complete(key, { status: "blocked", reason: "The authorized study revision changed." });
          return park(ctx, trail, "The authorized study revision changed before dispatch.");
        }
        const remaining = current.budget.spendMicrousdMax - current.budget.spendMicrousdUsed;
        if (effect.microusd > remaining) {
          await deps.ledger.complete(key, { status: "blocked", reason: "The study exceeds the remaining trail spending budget." });
          return park(ctx, current, "The approved study exceeds the remaining trail spending budget; allocate budget before dispatch.");
        }
        if (!await reserveStudy(ctx, current, key, effect.microusd)) {
          await deps.ledger.complete(key, { status: "blocked", reason: "Spending is unknown or another respondent operation is pending." });
          return park(ctx, current, "Respondent spending is unknown or reserved by another in-flight study; reconcile before another dispatch.");
        }
        const started = Date.now();
        let response: Awaited<ReturnType<NonNullable<ProbeHandlerDeps["respondents"]>>>;
        try {
          response = await deps.respondents!({ trail, purpose: effect.purpose, maxMicrousd: effect.microusd, operationKey: key });
        } catch {
          await deps.ledger.markAmbiguous(key, "Human study needs reconciliation; never repeat an uncertain publication.");
          await recordTrailUsage(ctx, trail.id, `${key}:usage`, { tokens: 0, costMicrousd: null, wallMs: Date.now() - started });
          throw new ReconciliationRequired(key, "Respondent study outcome requires reconciliation.");
        }
        const wallMs = Date.now() - started;
        const parsed = ProofItem.safeParse(response.item);
        if (!parsed.success || parsed.data.kind !== "voxq_study" || parsed.data.respondents <= 0
          || !parsed.data.study.trim() || !parsed.data.runId.trim() || parsed.data.spendMicrousd < 0
          || response.trailId !== trail.id || response.rev !== trail.rev || response.head !== trail.head) {
          await deps.ledger.markAmbiguous(key, "Respondent study returned unverified binding, completion or actual spending.");
          await recordTrailUsage(ctx, trail.id, `${key}:usage`, { tokens: 0, costMicrousd: null, wallMs });
          throw new ReconciliationRequired(key, "Respondent study evidence and spending require reconciliation.");
        }
        const item = parsed.data;
        result = StudyRecord.parse({ schema: 1, status: item.spendMicrousd > effect.microusd ? "over_limit" : "completed",
          trailId: trail.id, rev: trail.rev, base: trail.base.sha, head: trail.head, operationKey: key,
          purpose: effect.purpose, approvedBy: approved.who, item, usage: { tokens: 0, costMicrousd: item.spendMicrousd, wallMs } });
        if (Buffer.byteLength(canonicalJson(result)) > MAX_DOCUMENT) {
          await deps.ledger.markAmbiguous(key, "Respondent study receipt exceeds the durable bound.");
          await recordTrailUsage(ctx, trail.id, `${key}:usage`, result.usage);
          throw new ReconciliationRequired(key, "Respondent study receipt needs bounded reconciliation.");
        }
        await deps.ledger.complete(key, result);
      } else {
        if ((claim.record.result as { status?: string })?.status === "blocked") return;
        result = StudyRecord.parse(claim.record.result);
      }
      // Actual spend is charged once by a stable journal event; a lost local write can safely replay this accounting step.
      await recordTrailUsage(ctx, trail.id, `${key}:usage`, result.usage);
      await releaseStudy(ctx, trail.id, key);
      if (result.status === "over_limit") return park(ctx, trail, "The respondent provider exceeded the authorized spending limit.");
      const path = `evidence/respondents/${sha256Hex(effect.key)}.json`;
      await journalFiles(ctx, trail.id, async () => {
        const bytes = await ctx.journal.readFile(trail.id, "evidence/respondents/index.json");
        if (bytes && bytes.byteLength > MAX_DOCUMENT) throw new Unverified("respondent evidence index size");
        const entries = bytes ? StudyIndex.parse(JSON.parse(new TextDecoder().decode(bytes))) : [];
        const next = entries.filter(entry => entry.operationKey !== key);
        next.push({ path, operationKey: key, trailId: result.trailId, rev: result.rev, base: result.base, head: result.head });
        StudyIndex.parse(next);
        return { [path]: redact(canonicalJson(result), deps.secrets, MAX_DOCUMENT),
          "evidence/respondents/index.json": canonicalJson(next) };
      });
    },
  };
}
