import { z } from "zod";
import {
  ProofBundle, ProofItem, ReconciliationRequired, Unverified, canonicalJson, proofDigest, sha256Hex,
  type Journal, type OperationLedger, type Runner, type RunnerHandle, type Signal, type Trail,
} from "@ephyra/core";
import { redact } from "@ephyra/agent";
import { JournalConflict } from "@ephyra/journal";
import type { Git } from "./landing.ts";
import type { HandlerSlice, ServerContext } from "./context.ts";

const MAX_DOCUMENT = 256_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,179}$/;
const safePath = (path: string) => path.length > 0 && path.length <= 500 && !path.startsWith("/")
  && !path.split("/").some(part => part === ".." || part === "." || !part) && !/[\x00-\x1f\\]/.test(path);
const digest = (value: unknown) => `sha256:${sha256Hex(canonicalJson(value))}`;
const argv = z.array(z.string().min(1).max(4000).refine(value => !value.includes("\0"))).min(1).max(100);
const Source = z.object({ commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), path: z.string().refine(safePath),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), trailId: z.string().uuid().optional(), proofDigest: z.string().optional(),
  journalCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional() });
const Definition = z.object({ id: z.string().regex(ID), kind: z.enum(["intent", "regression"]),
  paths: z.array(z.string().min(1).max(500)).max(100), area: z.string().max(100).optional(),
  command: argv.optional(), script: z.string().min(1).max(MAX_DOCUMENT).optional(),
  unavailable: z.string().max(300).optional(), source: Source });
export type ProbeDefinition = z.infer<typeof Definition>;
export type ProbeReceipt = {
  id: string; kind: ProbeDefinition["kind"]; result: "pass" | "fail"; exit: number; log: string;
  source: ProbeDefinition["source"]; at: string;
};
export type ProbeExecution = {
  runner: Runner; handle: RunnerHandle; cwd?: string; remainingMs(): number; secrets?: string[];
};

/** Repository code only runs inside the caller's authorized isolated execution environment. */
export async function executeProbe(probe: ProbeDefinition, execution: ProbeExecution): Promise<ProbeReceipt> {
  const parsed = Definition.parse(probe);
  if (parsed.unavailable || (!parsed.command && !parsed.script)) throw new Unverified(parsed.unavailable ?? "probe command");
  const { runner, handle, cwd, remainingMs, secrets } = execution;
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
      ? (await this.options.git(["diff", "--name-only", trail.base.sha, trail.head])).split("\n").filter(Boolean) : [];
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
          probes.push(Definition.parse({ id: `intent:${raw.id}:${spec.id ?? index}`, kind: "intent",
            paths: raw.paths ?? [], area: raw.area, command,
            ...(!command ? { unavailable: `intent ${String(spec.kind).slice(0, 60)} probe needs an execution adapter` } : {}),
            source: { commit: document.commit, path, digest: digest(text) } }));
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
      if (!Number.isSafeInteger(effect.microusd) || effect.microusd <= 0) throw new Unverified("positive respondent spending authorization");
      const key = `respondents:${effect.key}`;
      const claim = await deps.ledger.begin(key, digest({ trail: trail.id, rev: trail.rev, head: trail.head,
        purpose: effect.purpose, microusd: effect.microusd, approved }));
      if (!claim.fresh && claim.record.status !== "done") throw new ReconciliationRequired(key, "Respondent study outcome is uncertain.");
      let result = claim.fresh ? undefined : claim.record.result as Awaited<ReturnType<NonNullable<ProbeHandlerDeps["respondents"]>>>;
      if (!result) {
        try {
          result = await deps.respondents!({ trail, purpose: effect.purpose, maxMicrousd: effect.microusd, operationKey: key });
          const item = ProofItem.parse(result.item);
          if (result.trailId !== trail.id || result.rev !== trail.rev || result.head !== trail.head || item.kind !== "voxq_study"
            || item.respondents <= 0 || item.spendMicrousd < 0 || item.spendMicrousd > effect.microusd) {
            throw new Unverified("respondent study binding and actual spend");
          }
          await deps.ledger.complete(key, result);
        } catch {
          await deps.ledger.markAmbiguous(key, "Human study needs reconciliation; never repeat an uncertain publication.");
          throw new ReconciliationRequired(key, "Respondent study outcome requires reconciliation.");
        }
      }
      await journalFiles(ctx, trail.id, { [`evidence/respondents/${sha256Hex(effect.key)}.json`]:
        redact(canonicalJson(result), deps.secrets, MAX_DOCUMENT) });
    },
  };
}
