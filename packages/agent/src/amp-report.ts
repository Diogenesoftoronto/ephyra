import { createHash } from "node:crypto";
import { ReconciliationRequired, Unverified, type AgentTask, type OperationLedger, type RunnerHandle } from "@ephyra/core";

export const AMP_REPORT_MAX_BYTES = 12 * 1024 * 1024;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const THREAD = /^T-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const NONCE = /^[a-f0-9]{64}$/;
const PROBE = /^\.ephyra\/repro\/[\w.-]+\.sh$/;

export type AmpReportRequest = {
  schema: 1; nonce: string; trailId: string; revision: number; step: AgentTask["step"];
  base: string; expectedThread: string | null; expiresAt: string; url: string;
};
export type AmpPolicyDecision = {
  decision: "allow" | "reject"; rule: string; reason: string; tool: string; callId: string;
};
export type AmpReport = {
  schema: 1; request: AmpReportRequest; threadId: string;
  probe?: { path: string; content: string };
  patch?: { head: string; bundle: string; digest: string };
  policies: AmpPolicyDecision[];
};
export interface AmpReportChannel {
  open(task: AgentTask, handle: RunnerHandle, threadId: string | null): Promise<AmpReportRequest>;
  collect(request: AmpReportRequest, threadId: string): Promise<AmpReport>;
}
export type AmpReportOptions = {
  origin: string;
  ledger: OperationLedger;
  /** Must cryptographically verify issuer, audience, signature, expiry and return the provider's exact thread claim. */
  verify(token: string, input: { audience: string; request: AmpReportRequest }): Promise<{ threadId: string }>;
  /** Rechecks current workspace, trail revision and configured executor authority. */
  authorize(request: AmpReportRequest): Promise<boolean>;
  now?: () => Date;
};

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sameRequest(a: unknown, b: AmpReportRequest): boolean {
  if (!object(a) || Object.keys(a).length !== Object.keys(b).length) return false;
  return Object.entries(b).every(([key, value]) => a[key] === value);
}

/** Reports are untrusted bytes until an authenticated executor and the expected task binding agree. */
export function validateAmpReport(value: unknown, request: AmpReportRequest, threadId: string): AmpReport {
  if (!object(value) || value.schema !== 1 || !sameRequest(value.request, request) || value.threadId !== threadId
    || !THREAD.test(threadId) || (request.expectedThread !== null && request.expectedThread !== threadId)
    || Object.keys(value).some((key) => !["schema", "request", "threadId", "probe", "patch", "policies"].includes(key)))
    throw new Unverified("Amp report task/thread binding");
  if (!Array.isArray(value.policies) || value.policies.length > 100) throw new Unverified("Amp report policy receipts");
  for (const policy of value.policies) {
    if (!object(policy) || !["allow", "reject"].includes(String(policy.decision))
      || Object.keys(policy).some((key) => !["decision", "rule", "reason", "tool", "callId"].includes(key))
      || !["rule", "reason", "tool", "callId"].every((key) => typeof policy[key] === "string" && policy[key].length > 0 && policy[key].length <= 500))
      throw new Unverified("Amp report policy receipt");
  }
  if (request.step === "repro") {
    if (!object(value.probe) || typeof value.probe.path !== "string" || !PROBE.test(value.probe.path)
      || typeof value.probe.content !== "string" || value.probe.content.length === 0
      || Object.keys(value.probe).some((key) => !["path", "content"].includes(key))
      || Buffer.byteLength(value.probe.content) > 256_000 || value.probe.content.includes("\0") || value.patch !== undefined)
      throw new Unverified("Amp report repro artifact");
  } else if (request.step === "patch") {
    const patch = value.patch;
    if (!object(patch) || Object.keys(patch).some((key) => !["head", "bundle", "digest"].includes(key))
      || typeof patch.head !== "string" || !SHA.test(patch.head) || patch.head === request.base
      || typeof patch.bundle !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(patch.bundle)
      || patch.bundle.length === 0 || patch.bundle.length > AMP_REPORT_MAX_BYTES || typeof patch.digest !== "string"
      || sha(Buffer.from(patch.bundle, "base64")) !== patch.digest || value.probe !== undefined)
      throw new Unverified("Amp report patch artifact");
  } else throw new Unverified("Amp report step");
  return structuredClone(value) as AmpReport;
}

/** Durable, workspace-scoped inbox. It never assumes an issuer, JWKS URL or undocumented provider claim. */
export class AmpReportInbox implements AmpReportChannel {
  private readonly origin: string;
  private readonly now: () => Date;
  constructor(private readonly options: AmpReportOptions) {
    const url = new URL(options.origin);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("Amp reports require a trusted HTTPS origin");
    this.origin = url.origin;
    this.now = options.now ?? (() => new Date());
  }

  async open(task: AgentTask, handle: RunnerHandle, threadId: string | null): Promise<AmpReportRequest> {
    if (!["repro", "patch"].includes(task.step) || threadId !== null && !THREAD.test(threadId)) throw new Unverified("Amp report request");
    const base = task.trail.head ?? task.trail.base.sha;
    if (!SHA.test(base)) throw new Unverified("Amp report base commit");
    const binding = { trailId: task.trail.id, revision: task.trail.rev, step: task.step, base, expectedThread: threadId,
      handle: handle.id, origin: this.origin };
    const nonce = sha(JSON.stringify(binding));
    const key = `amp:request:${nonce}`;
    const claim = await this.options.ledger.begin(key, sha(JSON.stringify(binding)));
    if (!claim.fresh) {
      if (claim.record.status === "done") {
        const request = claim.record.result as AmpReportRequest;
        await this.allowed(request);
        return request;
      }
      throw new ReconciliationRequired(key, "Amp report request needs reconciliation");
    }
    const request: AmpReportRequest = { schema: 1, nonce, trailId: task.trail.id, revision: task.trail.rev, step: task.step,
      base, expectedThread: threadId, expiresAt: new Date(this.now().getTime() + (task.budget.wallclockS + 60) * 1000).toISOString(),
      url: `${this.origin}/amp/reports/${nonce}` };
    await this.options.ledger.complete(key, request);
    await this.allowed(request);
    return request;
  }

  private async allowed(request: AmpReportRequest): Promise<void> {
    if (Date.parse(request.expiresAt) <= this.now().getTime() || !await this.options.authorize(request))
      throw new Unverified("Amp report authority expired or revoked");
  }

  private async request(nonce: string): Promise<AmpReportRequest> {
    if (!NONCE.test(nonce)) throw new Unverified("Amp report request id");
    const operation = await this.options.ledger.get(`amp:request:${nonce}`);
    if (!operation || operation.status !== "done") throw new Unverified("Amp report request unavailable");
    const request = operation.result as AmpReportRequest;
    await this.allowed(request);
    return request;
  }

  async accept(nonce: string, token: string, value: unknown): Promise<{ digest: string }> {
    const request = await this.request(nonce);
    if (!token || token.length > 20_000) throw new Unverified("Amp report authentication");
    const identity = await this.options.verify(token, { audience: this.origin, request });
    const report = validateAmpReport(value, request, identity.threadId);
    await this.allowed(request);
    const digest = sha(JSON.stringify(report));
    const key = `amp:report:${nonce}`;
    const claim = await this.options.ledger.begin(key, digest);
    if (!claim.fresh) {
      if (claim.record.status === "done") return { digest };
      throw new ReconciliationRequired(key, "Amp report acceptance needs reconciliation");
    }
    await this.options.ledger.complete(key, report);
    return { digest };
  }

  async collect(request: AmpReportRequest, threadId: string): Promise<AmpReport> {
    const stored = await this.request(request.nonce);
    if (!sameRequest(stored, request)) throw new Unverified("Amp report request substitution");
    const record = await this.options.ledger.get(`amp:report:${request.nonce}`);
    if (!record || record.status !== "done") throw new Unverified("authenticated ephyra_report plugin result unavailable");
    const report = validateAmpReport(record.result, request, threadId);
    await this.allowed(request);
    return report;
  }
}
