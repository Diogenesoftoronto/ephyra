import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BootstrapAssessment, PeopleConnection, ReconciliationRequired, Unverified,
  type BootstrapRequest, type InvestigationContact, type OperationLedger, type SetupRun,
} from "@ephyra/core";
import { redact } from "@ephyra/agent";
import type { Fetch } from "../auth/crypto.ts";
import { canonicalJson } from "../audit.ts";
import type { ServerContext } from "../wiring/context.ts";
import { parsePublicHttps, publicHttpsFetch } from "./network.ts";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const payloadHash = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const jobSchema = z.object({ binding: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const receiptSchema = z.object({
  schema: z.literal(1), status: z.literal("acknowledged"), receipt: z.string().regex(/^http:2\d\d$/),
  setupId: z.string().regex(/^[a-f0-9]{32}$/), head: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  requestIds: z.array(digest).min(1).max(40), recipient: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/),
  authorityDigest: digest, payloadDigest: digest, at: z.string().datetime(),
}).strict();
export type BootstrapContactOptions = {
  ctx: ServerContext; ledger: OperationLedger; did: string; workspaceId: string;
  current: () => Promise<SetupRun | null>;
  connection: () => Promise<{ settings: PeopleConnection; token?: string } | null>;
  publicOrigin: string; fetcher?: Fetch; secrets?: string[]; timeoutMs?: number;
};
type Plan = {
  binding: string; run: SetupRun; requests: BootstrapRequest[]; recipient: InvestigationContact;
  authorityDigest: string; url: string; token: string;
};
const denied = () => new Unverified("Bootstrap contact is no longer authorized or current.");
const covers = (contact: InvestigationContact, request: BootstrapRequest) => !contact.areas.length
  || contact.areas.some((area) => ["*", "bootstrap", "setup", request.kind === "context" ? "application" : "automation-control"].includes(area));

/** Owner-only, explicitly configured bridge delivery. The signed-in Inbox remains the place to answer. */
export class BootstrapContact {
  private readonly secrets: Set<string>;
  private readonly timeoutMs: number;
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly options: BootstrapContactOptions) {
    this.secrets = new Set(options.secrets ?? []);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000)
      throw new Error("Invalid bootstrap contact deadline.");
    if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(options.did) || !/^[A-Za-z0-9._:-]{1,100}$/.test(options.workspaceId))
      throw new Error("Invalid bootstrap contact scope.");
    options.ctx.jobs.register("bootstrap_contact", async (payload) => {
      const { binding } = jobSchema.parse(payload);
      const previous = this.running.get(binding);
      const next = (async () => { try { await previous; } catch { /* Durable receipts decide whether another dispatch is allowed. */ }
        await this.deliver(binding); })();
      this.running.set(binding, next);
      try { await next; }
      finally { if (this.running.get(binding) === next) this.running.delete(binding); }
    });
  }
  private clean(value: string, max: number) { return redact(value, [...this.secrets], max).slice(0, max); }
  private async plan(run: SetupRun | null): Promise<Plan | null> {
    if (!run?.bootstrap || !["ready", "blocked"].includes(run.status)
      || run.blockers.some(blocker => blocker.id === "base_changed")) return null;
    const parsed = BootstrapAssessment.safeParse(run.bootstrap);
    if (!parsed.success || parsed.data.setupId !== run.id || parsed.data.head !== run.repository.head) return null;
    const raw = await this.options.connection();
    if (raw?.token) this.secrets.add(raw.token);
    const settings = PeopleConnection.safeParse(raw?.settings);
    if (!settings.success || !settings.data.enabled || settings.data.workspaceId !== this.options.workspaceId
      || !settings.data.webhookUrl || !settings.data.keyConfigured || !raw?.token
      || raw.token.length > 8192 || /[\r\n\0]/.test(raw.token)) return null;
    const open = parsed.data.requests.filter((request) => request.status === "open").sort((a, b) => a.id.localeCompare(b.id));
    if (!open.length) return null;
    const candidates = settings.data.contacts.filter((contact) => contact.did === this.options.did
      && this.clean(contact.id, 160) === contact.id && this.clean(contact.did!, 300) === contact.did)
      .map((contact) => ({ contact, requests: open.filter((request) => covers(contact, request)) }))
      .filter((candidate) => candidate.requests.length)
      .sort((a, b) => b.requests.length - a.requests.length || a.contact.id.localeCompare(b.contact.id));
    const selected = candidates[0];
    if (!selected) return null;
    const url = parsePublicHttps(settings.data.webhookUrl).href;
    const publicUrl = parsePublicHttps(this.options.publicOrigin);
    if (publicUrl.origin !== this.options.publicOrigin) throw denied();
    const authorityDigest = hash({ did: this.options.did, workspaceId: this.options.workspaceId, settings: settings.data });
    const binding = hash({ schema: 1, setupId: run.id, head: run.repository.head,
      requests: selected.requests.map((request) => request.id), recipient: selected.contact.id, authorityDigest });
    return { binding, run, requests: selected.requests, recipient: selected.contact, authorityDigest, url, token: raw.token };
  }

  /** Queue payloads contain a digest only. No request text, credentials or destination URL enter the job record. */
  async schedule(run: SetupRun): Promise<void> {
    const plan = await this.plan(run);
    if (!plan) return;
    await this.options.ctx.jobs.enqueue("bootstrap_contact", `bootstrap-contact:${plan.binding}`, { binding: plan.binding });
  }
  private async live(binding: string, expected?: Plan): Promise<Plan> {
    const plan = await this.plan(await this.options.current());
    if (!plan || plan.binding !== binding || expected && (plan.token !== expected.token || plan.url !== expected.url)) throw denied();
    return plan;
  }
  private async deadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Unverified("Bootstrap contact timed out.")); }, this.timeoutMs);
    });
    try { return await Promise.race([work(controller.signal), timeout]); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  private async deliver(binding: string): Promise<void> {
    const key = `bootstrap-contact:${binding}`;
    const plan = await this.live(binding);
    const claim = await this.options.ledger.begin(key, hash({ schema: 1, binding }));
    if (!claim.fresh) {
      if (claim.record.status !== "done") throw new ReconciliationRequired(key, "Bootstrap contact has an uncertain delivery outcome.");
      const receipt = receiptSchema.safeParse(claim.record.result);
      if (!receipt.success || receipt.data.setupId !== plan.run.id || receipt.data.head !== plan.run.repository.head
        || receipt.data.authorityDigest !== plan.authorityDigest || receipt.data.recipient !== plan.recipient.id
        || canonicalJson(receipt.data.requestIds) !== canonicalJson(plan.requests.map((request) => request.id)))
        throw new ReconciliationRequired(key, "The saved bootstrap contact receipt needs reconciliation.");
      return;
    }
    try {
      const receipt = await this.deadline(async (signal) => {
        const fresh = await this.live(binding, plan);
        const body = JSON.stringify({ type: "ephyra.bootstrap.request", id: binding,
          workspaceId: this.options.workspaceId, setupId: fresh.run.id, head: fresh.run.repository.head,
          recipient: fresh.recipient.id, requestIds: fresh.requests.map((request) => request.id),
          requests: fresh.requests.map((request) => ({ id: request.id, kind: request.kind,
            question: this.clean(request.question, 2000), ...(request.action ? { action: this.clean(request.action, 2000) } : {}) })),
          inboxUrl: `${this.options.publicOrigin}/app/#/inbox`,
          limitation: "Answer in the signed-in owner Inbox. Answers are context and cannot grant authority, credentials or spending.",
        });
        // Recheck authority after constructing the payload and immediately before dispatch.
        const ready = await this.live(binding, fresh);
        if (signal.aborted) throw denied();
        const response = await (this.options.fetcher ?? publicHttpsFetch)(ready.url, {
          method: "POST", redirect: "error", credentials: "omit", signal,
          headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json", "idempotency-key": key }, body,
        });
        void response.body?.cancel().catch(() => undefined);
        if (!response.ok || response.redirected) throw new Unverified("The bridge did not acknowledge bootstrap contact.");
        await this.live(binding, ready);
        return { schema: 1 as const, status: "acknowledged" as const, receipt: `http:${response.status}`,
          setupId: ready.run.id, head: ready.run.repository.head, requestIds: ready.requests.map((request) => request.id),
          recipient: ready.recipient.id, authorityDigest: ready.authorityDigest, payloadDigest: payloadHash(body),
          at: this.options.ctx.clock.now().toISOString() };
      });
      await this.options.ledger.complete(key, receiptSchema.parse(receipt));
    } catch {
      try { await this.options.ledger.markAmbiguous(key, "Bootstrap contact did not produce a durable acknowledgement under unchanged authority."); }
      catch { /* An existing pending record still prohibits automatic replay. */ }
      throw new ReconciliationRequired(key, "Bootstrap contact needs reconciliation before another delivery attempt.");
    }
  }
}
