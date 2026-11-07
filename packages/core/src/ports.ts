// Ports: the interfaces every adapter package implements and the server wires together.
// Adapters depend on @ephyra/core only. Apps depend on adapters. Packages never import apps or each other
// unless listed in AGENTS.md "Allowed package dependencies".
import type { ExtractionRequest, ExtractionResponse, JudgementRequest, JudgementResponse } from "./contracts.ts";
import type { TrailEvent } from "./events.ts";
import type { LandingMode, LandingReceipt, ProofBundle, Signal, Trail } from "./schemas.ts";

export interface Clock { now(): Date }
export interface IdGen { uuidv7(): string }

/** Every side effect carries a stable key; ambiguous outcomes surface as ReconciliationRequired, never a blind retry. */
export class ReconciliationRequired extends Error {
  constructor(public readonly operationKey: string, message: string) { super(message); this.name = "ReconciliationRequired"; }
}
export class Unverified extends Error {
  constructor(public readonly feature: string) { super(`unverified integration: ${feature}`); this.name = "Unverified"; }
}

// ───── Journal (git, refs/ephyra/trails/<id>/…) ─────
export type JournalHead = string; // commit oid of refs/ephyra/trails/<id>/journal
export type JournalFiles = Record<string, string | Uint8Array>; // path within the trail tree → content
export interface Journal {
  /** Create the journal for a new trail. Fails if it exists. */
  create(trail: Trail, first: TrailEvent, files?: JournalFiles): Promise<JournalHead>;
  /** Compare-and-swap append. Rejects with a conflict error if `expectedHead` is stale. */
  append(trailId: string, expectedHead: JournalHead, trail: Trail, events: TrailEvent[], files?: JournalFiles): Promise<JournalHead>;
  read(trailId: string): Promise<{ head: JournalHead; trail: Trail; events: TrailEvent[] } | null>;
  readFile(trailId: string, path: string): Promise<Uint8Array | null>;
  list(): Promise<string[]>;
  /** Immutable refs: refs/ephyra/trails/<id>/revisions/NNNN → patch tip, …/proofs/NNNN → proof manifest commit. */
  pinRevision(trailId: string, n: number, commit: string): Promise<void>;
  pinProof(trailId: string, n: number, bundle: ProofBundle): Promise<{ digest: string; commit: string }>;
}

// ───── Signals ─────
export interface SignalStore {
  /** Insert or merge by fingerprint (count/lastSeen updated). Returns the stored signal and whether it is new. */
  upsert(signal: Signal): Promise<{ signal: Signal; isNew: boolean }>;
  get(id: string): Promise<Signal | null>;
  byFingerprint(fingerprint: string): Promise<Signal | null>;
  /** Occurrences of a fingerprint since a time (for watch/rollback). */
  countSince(fingerprint: string, since: Date): Promise<number>;
  /** New fingerprints whose top in-app frame is in one of `files`, since a time. */
  newFingerprintsInFiles(files: string[], since: Date): Promise<Signal[]>;
  /** Errors / requests for a route in a window, for baselines. */
  errorRate(route: string, from: Date, to: Date): Promise<{ errors: number; requests: number } | null>;
  mute(fingerprint: string, until: Date): Promise<void>;
  isMuted(fingerprint: string, at: Date): Promise<boolean>;
}

// ───── System One backends ─────
export type BackendKind = "notorganic" | `byok:${string}` | `selfhosted:${string}`;
export interface DecideBackend {
  readonly kind: BackendKind;
  /** Registry alias, e.g. "jev-hosted". The *response* model string is the identity thresholds key on. */
  readonly alias: string;
  readonly supports: ReadonlyArray<"noul" | "choice" | "score">;
  decide(req: JudgementRequest, opts: { idempotencyKey: string; signal?: AbortSignal }): Promise<JudgementResponse>;
}
export interface ExtractBackend {
  readonly kind: BackendKind | "parser";
  readonly alias: string;
  extract(req: ExtractionRequest, opts: { idempotencyKey: string; signal?: AbortSignal }): Promise<ExtractionResponse>;
}

// ───── Forges ─────
export type ForgeEvent = {
  workspace: string; repo: string; adapter: string;
  sourceId: string; cursor: string; occurredAt: string;
  kind: "push" | "proposal.opened" | "proposal.updated" | "review.comment" | "review.decision" | "ci.status" | "issue";
  objectId?: string; revision?: string; commit?: string; ref?: string;
  actor: string; payloadDigest: string; body?: string;
};
export type ForgeCapabilities = {
  adapter: string;
  events: boolean; conditionalWrites: boolean; proposals: boolean; ci: boolean; signing: boolean;
  landingModes: LandingMode[];
  customRefs: "supported" | "unsupported" | "unknown";
  verified: boolean; // false ⇒ adapter is a contract stub; writes throw Unverified
};
export type LandingPlan = {
  trailId: string; mode: LandingMode; target: string;
  expectedBase: string; head: string; proofDigest: string;
  commitMessage?: string; // auto_land / trail_ref commit message incl. trailers
};
export interface ForgeAdapter {
  readonly name: string;
  capabilities(repo: string): Promise<ForgeCapabilities>;
  events(cursor: string | null, signal?: AbortSignal): AsyncIterable<ForgeEvent>;
  /** `proofDigest` binds the plan to the accepted proof bundle (design/02 §1). */
  prepareLanding(trail: Trail, mode: LandingMode, expectedBase: string, proofDigest: string): Promise<LandingPlan>;
  land(plan: LandingPlan, authorizationId: string, idempotencyKey: string): Promise<LandingReceipt>;
  /** Revert a previous landing through the same mode. */
  revert(receipt: LandingReceipt, idempotencyKey: string): Promise<LandingReceipt>;
}

// ───── Runners ─────
export type ServiceProfile = {
  name: string; digest: string;
  /** "egress_allowlist" needs host-enforced destination filtering (BYO tier only; Railway cannot enforce it). */
  network: "none" | "egress" | "egress_allowlist" | "private";
  egressAllowlist?: string[];
  readOnlyProd: boolean;
  credentials: string[]; // scoped credential names, never values
  limits: { cpu: number; memoryMb: number; diskMb: number; timeoutS: number };
};
export type RunnerHandle = { id: string; runner: string; workdir: string; trailId: string; attempt: number; leaseExpiresAt: string };
export type ExecOutput = { stream: "stdout" | "stderr"; chunk: string } | { exit: number; durationMs: number; timedOut: boolean };
export type ArtifactRef = { path: string; digest: string; bytes: number; mediaType: string };
export interface Runner {
  readonly name: string;
  readonly capabilities: { checkpoint: "none" | "disk" | "memory"; network: ServiceProfile["network"][]; shell: boolean; browser: boolean };
  allocate(req: { trail: Trail; attempt: number; repoUrl: string; commit: string; profile: ServiceProfile; leaseS?: number }): Promise<RunnerHandle>;
  exec(handle: RunnerHandle, command: string[], opts: { cwd?: string; env?: Record<string, string>; deadlineMs: number }): AsyncIterable<ExecOutput>;
  writeFile(handle: RunnerHandle, path: string, content: string | Uint8Array): Promise<void>;
  readFile(handle: RunnerHandle, path: string): Promise<Uint8Array | null>;
  checkpoint(handle: RunnerHandle): Promise<{ snapshotId: string; kind: "disk" | "memory" }>;
  restore(snapshotId: string, req: { trail: Trail; attempt: number; profile: ServiceProfile }): Promise<RunnerHandle>;
  exportArtifacts(handle: RunnerHandle, paths: string[]): Promise<ArtifactRef[]>;
  destroy(handle: RunnerHandle): Promise<{ destroyed: true; at: string }>;
}

// ───── Coding agents ─────
export type AgentStep = "research" | "repro" | "plan" | "patch" | "review";
export type AgentTask = {
  step: AgentStep;
  trail: Trail;
  /** Untrusted material (signal text, logs, comments) — always wrapped as data, never instructions. */
  untrusted: Record<string, string>;
  /** Trusted constraints: policy text, human notes from checkpoints, prior artefacts. */
  context: Record<string, string>;
  budget: { tokens: number; wallclockS: number };
};
export type AgentResult = {
  ok: boolean;
  /** Files written into the journal tree, e.g. "hypothesis.md", "plan.md", "patch/diffstat.txt". */
  artefacts: Record<string, string>;
  /** For repro: the probe command and path; for patch: new head sha. */
  outputs: Record<string, string>;
  usage: { tokens: number; costMicrousd: number | null; model: string };
  /** Entire checkpoint ids observed for this session, never synthesized. */
  sessions: { provider: "entire"; checkpoint: string }[];
  error?: string;
};
export interface CodingAgent {
  readonly name: string; // e.g. "claude-code", "codex"
  run(task: AgentTask, runner: Runner, handle: RunnerHandle): Promise<AgentResult>;
}

// ───── Evidence ─────
export type EvidenceHit = { source: string; id: string; title: string; snippet: string; revision?: string; score: number; uri?: string };
export interface EvidenceSource {
  readonly name: string; // "git", "entire", "otel", "trails", "voxq"
  search(query: { text: string; files?: string[]; fingerprint?: string; since?: string; limit: number }): Promise<EvidenceHit[]>;
  fetch(hit: EvidenceHit): Promise<{ mediaType: string; content: string }>;
}

// ───── Orchestration-facing helpers ─────
export type InboxItem = {
  trailId: string; short: string; title: string; area: string; risk: Trail["risk"]; severity: number;
  state: Trail["state"];
  /** Bound revision: a decision is rejected if the trail's head or proof digest changed since this item was created. */
  bound: { rev: number; head?: string; proofDigest?: string };
  /** Where `o` goes: devenv portal, patch, pull, Canvas or ISL stack. */
  landingUrl?: string;
  /** Journal path of evidence/index.json, shown by `e`. */
  evidenceIndex?: string;
  kind: "checkpoint" | "spend" | "parked" | "notice";
  checkpoint?: "A" | "B" | "C"; blocking: boolean; shadowVerdict?: "approve" | "revise" | "reject";
  artefact: { path: string; summary: string };
  createdAt: string;
};

// ───── Durable operation keys (idempotency across processes) ─────
export type OperationRecord = { key: string; planDigest: string; status: "pending" | "done" | "reconciliation_required"; result?: unknown; at: string };
export interface OperationLedger {
  /** Claim a key for a plan. Returns the existing record if the key was used; throws if the same key was used for a different plan. */
  begin(key: string, planDigest: string): Promise<{ fresh: true } | { fresh: false; record: OperationRecord }>;
  complete(key: string, result: unknown): Promise<void>;
  markAmbiguous(key: string, note: string): Promise<void>;
  get(key: string): Promise<OperationRecord | null>;
}
