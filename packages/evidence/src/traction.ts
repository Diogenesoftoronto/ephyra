import { createHash } from "node:crypto";
import { Unverified, type EvidenceHit, type EvidenceSource } from "@ephyra/core";

export type TractionScope = { accountId: string; workspaceId: string; projectIds: readonly string[] };
export type TractionEvidenceOptions = {
  /** Trusted server configuration, never taken from a model/tool argument. */
  origin: string;
  scope: TractionScope;
  /** Resolve an operator credential already authorized for this account/workspace/project binding. */
  credential: (scope: TractionScope) => Promise<string | null>;
  fetcher?: (url: string, init?: Parameters<typeof fetch>[1]) => Promise<Response>;
  timeoutMs?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => Date;
};
export type TractionObservation = {
  metric: string;
  observedAt: string;
  points: { date: string; value: number; coverage: "complete" | "partial" | "missing" | "unknown" }[];
  provenance: {
    label: string; kind: string; unit: string; aggregation: string; scope: string; authority: string;
    coverage: "complete" | "partial" | "missing"; serviceId: string; truncated: boolean;
  } | null;
  omittedPoints: number;
};
export type TractionSourceEvidence = {
  source: string;
  status: "healthy" | "partial" | "failed" | "unconfigured" | "stale";
  checkedAt: string | null;
  lastSuccessAt: string | null;
  coverage: "complete" | "partial" | "missing";
  historical: boolean;
  observations: TractionObservation[];
};
export type TractionProjectEvidence = { project: string; name: string; sources: TractionSourceEvidence[] };
export type TractionSnapshot = {
  fetchedAt: string;
  reportedAt: string;
  historical: boolean;
  projects: TractionProjectEvidence[];
  limitations: string[];
};

type Obj = Record<string, unknown>;
const invalid = (): never => { throw new Unverified("Traction returned an unsupported or incomplete state"); };
const object = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : invalid();
const string = (value: unknown, max = 256): string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
const array = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : invalid();
const timestamp = (value: unknown): string => {
  const text = string(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text))) invalid();
  return text;
};
const nullableTime = (value: unknown) => value === null ? null : timestamp(value);
const member = <T extends string>(value: unknown, choices: readonly T[]): T =>
  typeof value === "string" && choices.includes(value as T) ? value as T : invalid();
const coverage = (value: unknown) => member(value, ["complete", "partial", "missing"] as const);
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : invalid();
const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const LIMITATIONS = [
  "Aggregate project context only; no trace, fingerprint, user-session or causal match is established.",
  "Complete coverage means a source response, not complete client instrumentation or proof that a fix worked.",
  "Failed or stale sources retain historical observations; absent values are never converted to zero.",
  "Global briefings, model interpretations and notification records are excluded from project-scoped evidence.",
];

function observation(value: unknown, project: string, source: string): TractionObservation {
  const row = object(value);
  if (row.project !== project || row.source !== source) invalid();
  const points = array(row.points, 400).map((entry) => {
    const point = object(entry);
    const date = string(point.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) invalid();
    return { date, value: finite(point.value), coverage: point.coverage === undefined ? "unknown" as const : coverage(point.coverage) };
  });
  let provenance: TractionObservation["provenance"] = null;
  if (row.provenance !== undefined) {
    const p = object(row.provenance);
    if (typeof p.truncated !== "boolean") invalid();
    provenance = {
      label: string(p.label), kind: member(p.kind, ["product", "operational", "ai_usage"]), unit: string(p.unit),
      aggregation: member(p.aggregation, ["sum", "distinct", "max", "last", "mean"]),
      scope: member(p.scope, ["application", "account"]),
      authority: member(p.authority, ["server", "provider", "client_reported", "estimated"]),
      coverage: coverage(p.coverage), serviceId: string(p.serviceId), truncated: p.truncated as boolean,
    };
  }
  return {
    metric: string(row.metric), observedAt: timestamp(row.observedAt), provenance,
    points: points.sort((a, b) => a.date.localeCompare(b.date)).slice(-30), omittedPoints: Math.max(0, points.length - 30),
  };
}

function parseSnapshot(value: unknown, scope: TractionScope, now: Date, maxAgeMs: number): TractionSnapshot {
  const state = object(value);
  const reportedAt = timestamp(state.now);
  const old = (at: string | null) => !at || now.getTime() - Date.parse(at) > maxAgeMs || Date.parse(at) > now.getTime() + 60_000;
  const historical = old(reportedAt);
  const projects = array(state.projects, 1000).map(object);
  const sources = array(state.sources, 2000).map(object);
  const selected = scope.projectIds.map((id) => {
    const matches = projects.filter((p) => p.id === id);
    if (matches.length !== 1) throw new Unverified("Traction does not expose a configured project");
    const seen = new Set<string>();
    const rows = sources.filter((s) => s.project === id).map((s): TractionSourceEvidence => {
      const source = string(s.source);
      if (seen.has(source)) invalid();
      seen.add(source);
      const status = member(s.status, ["healthy", "partial", "failed", "unconfigured", "stale"] as const);
      const checkedAt = nullableTime(s.checkedAt);
      const lastSuccessAt = nullableTime(s.lastSuccessAt);
      const observations = array(s.observations, 100).map((o) => observation(o, id, source));
      const historic = historical || old(checkedAt) || ["failed", "unconfigured", "stale"].includes(status);
      const incomplete = status === "partial" || observations.some((o) =>
        o.provenance && (o.provenance.coverage !== "complete" || o.provenance.truncated)
        || o.points.some((point) => point.coverage === "partial" || point.coverage === "missing"));
      return {
        source, status, checkedAt, lastSuccessAt, historical: historic, observations,
        coverage: historic || observations.length === 0 ? "missing" : incomplete ? "partial" : "complete",
      };
    });
    return { project: id, name: string(matches[0]!.name), sources: rows };
  });
  return { fetchedAt: now.toISOString(), reportedAt, historical, projects: selected, limitations: [...LIMITATIONS] };
}

async function boundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Unverified("Traction response exceeded the evidence limit");
  }
  if (!response.body) invalid();
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stop = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Unverified("Traction evidence request timed out");
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Unverified("Traction response exceeded the evidence limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}

/** Read-only adapter to the inspected Traction /api/state contract. No poll, notification or provider call is triggered. */
export class TractionEvidence implements EvidenceSource {
  readonly name = "traction";
  private readonly origin: string;
  private readonly scope: TractionScope;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly receipts = new Map<string, string>();

  constructor(private readonly options: TractionEvidenceOptions) {
    const url = new URL(options.origin);
    if (url.protocol !== "https:" || url.origin !== options.origin || url.username || url.password) {
      throw new Error("Traction requires a configured HTTPS origin without a path or credentials");
    }
    this.origin = url.origin;
    this.scope = {
      accountId: string(options.scope.accountId), workspaceId: string(options.scope.workspaceId),
      projectIds: [...options.scope.projectIds],
    };
    if (!this.scope.projectIds.length || this.scope.projectIds.length > 20
      || new Set(this.scope.projectIds).size !== this.scope.projectIds.length) throw new Error("Select 1 to 20 distinct Traction projects");
    this.scope.projectIds.forEach((id) => string(id, 128));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxBytes ?? 1_000_000;
    this.maxAgeMs = options.maxAgeMs ?? 2 * 60 * 60_000;
    if (![this.timeoutMs, this.maxBytes, this.maxAgeMs].every((v) => Number.isSafeInteger(v) && v > 0)
      || this.timeoutMs > 30_000 || this.maxBytes > 2_000_000 || this.maxAgeMs > 7 * 24 * 60 * 60_000) {
      throw new Error("Invalid Traction evidence limits");
    }
  }

  async read(): Promise<TractionSnapshot> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Unverified("Traction evidence request timed out")); }, this.timeoutMs);
    });
    const read = async () => {
      const token = await this.options.credential(structuredClone(this.scope));
      if (!token || token.length < 32 || token.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(token)) {
        throw new Unverified("Traction credential is not configured for this workspace");
      }
      if (controller.signal.aborted) throw new Unverified("Traction evidence request timed out");
      const request = this.options.fetcher ?? fetch;
      const response = await request(`${this.origin}/api/state`, {
        method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
      });
      if (response.redirected || response.status >= 300 || !response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Unverified("Traction evidence is unavailable or access was denied");
      }
      const state = await boundedJson(response, this.maxBytes, controller.signal);
      const snapshot = parseSnapshot(state, this.scope, this.options.now?.() ?? new Date(), this.maxAgeMs);
      // Error bodies and arbitrary fields never escape. Also scrub reflected credentials from allowed text fields.
      const secrets = [token, encodeURIComponent(token), Buffer.from(token).toString("base64")];
      return JSON.parse(JSON.stringify(snapshot), (_key, value: unknown) => typeof value === "string"
        ? secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value) : value) as TractionSnapshot;
    };
    try { return await Promise.race([read(), deadline]); }
    catch (error) {
      if (error instanceof Unverified) throw error;
      throw new Unverified("Traction evidence could not be verified");
    } finally { clearTimeout(timer); controller.abort(); }
  }

  async search(query: { text: string; files?: string[]; fingerprint?: string; since?: string; limit: number }): Promise<EvidenceHit[]> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error("Invalid evidence limit");
    const snapshot = await this.read();
    return snapshot.projects.slice(0, query.limit).map((project) => {
      const content = json({
        ...snapshot, projects: [project], omittedProjects: Math.max(0, snapshot.projects.length - query.limit),
      });
      const id = digest(`${json(this.scope)}:${content}`);
      this.receipts.set(id, content);
      while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
      return {
        source: this.name, id, title: `Traction context: ${project.project}`, score: 1,
        revision: digest(content), snippet: `<untrusted_traction>${content}</untrusted_traction>`,
      };
    });
  }

  async fetch(hit: EvidenceHit): Promise<{ mediaType: string; content: string }> {
    const content = hit.source === this.name ? this.receipts.get(hit.id) : undefined;
    if (content === undefined) throw new Unverified("Traction evidence receipt is unavailable; read the configured source again");
    return { mediaType: "application/json", content };
  }
}
