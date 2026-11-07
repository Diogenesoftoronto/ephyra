import {
  ActivityItem, Draft, PersonaId, PolicyDoc, Trail, TrailEvent, UsageEntry, UsageSummary,
  type Persona,
} from "@ephyra/core";
import { z } from "zod";

export class ApiError extends Error {
  /** `detail` is the server's own `{ error }` text; it is shown as text, never as markup. */
  constructor(readonly status: number, readonly detail?: string) {
    super(status === 409 ? "This item changed. Refresh before trying again." : `API request failed (${status})`);
  }
}

/** An interrupted mutation may have succeeded. Reconcile its operation key before any retry. */
export class UnknownWriteOutcome extends Error {
  constructor(readonly operationKey: string) {
    super("The write outcome is unknown. Reconcile before retrying.");
  }
}

// `InboxItem` is a type in core (ports.ts) with no schema, so the console validates the wire shape itself.
export const InboxItemSchema = z.object({
  trailId: z.string(), short: z.string(), title: z.string(), area: z.string(),
  risk: z.enum(["low", "medium", "high", "critical"]), severity: z.number(),
  state: z.string(),
  bound: z.object({ rev: z.number().int(), head: z.string().optional(), proofDigest: z.string().optional() }),
  landingUrl: z.string().optional(), evidenceIndex: z.string().optional(),
  kind: z.enum(["checkpoint", "spend", "parked", "notice"]),
  checkpoint: z.enum(["A", "B", "C"]).optional(), blocking: z.boolean(),
  shadowVerdict: z.enum(["approve", "revise", "reject"]).optional(),
  artefact: z.object({ path: z.string(), summary: z.string() }),
  createdAt: z.string(),
});
export type InboxEntry = z.infer<typeof InboxItemSchema>;

export const TrailDetailSchema = z.object({ trail: Trail, events: z.array(TrailEvent) });
export type TrailDetail = z.infer<typeof TrailDetailSchema>;

export type UsageQuery = { from?: string; to?: string; persona?: PersonaId | "none"; engine?: string; trail?: string };
export type EntriesQuery = UsageQuery & { cursor?: string; limit?: number };
export type EntriesPage = { entries: UsageEntry[]; cursor?: string };
export type Verdict = "approve" | "revise" | "reject";
export type TrailAction = "comment" | "claim" | "release" | "park" | "resume";

/**
 * Everything the console needs from the server. `ConsoleClient` speaks HTTP; `FakeApi` (src/fake) is the
 * deterministic implementation used by Storybook, tests and `?demo`. Every write takes an operation key.
 */
export interface ConsoleApi {
  personas(): Promise<Persona[]>;
  activity(limit?: number): Promise<ActivityItem[]>;
  usage(query?: UsageQuery): Promise<UsageSummary>;
  entries(query?: EntriesQuery): Promise<EntriesPage>;
  inbox(): Promise<InboxEntry[]>;
  trail(id: string): Promise<TrailDetail>;
  decide(trailId: string, input: { checkpoint: "A" | "B" | "C" | "spend"; verdict: Verdict; note?: string }, op: string): Promise<void>;
  trailAction(trailId: string, action: TrailAction, input: { text?: string; reason?: string }, op: string): Promise<void>;
  docs(): Promise<PolicyDoc[]>;
  doc(path: string): Promise<PolicyDoc>;
  drafts(status?: Draft["status"]): Promise<Draft[]>;
  draft(id: string): Promise<Draft>;
  createDraft(path: string, op: string): Promise<Draft>;
  sendMessage(id: string, text: string, op: string): Promise<Draft>;
  updateContent(id: string, content: string, baseDigest: string, op: string): Promise<Draft>;
  applyProposal(id: string, messageId: string, op: string): Promise<Draft>;
  publish(id: string, op: string): Promise<Draft>;
  discard(id: string, op: string): Promise<Draft>;
}

const PersonaWire = z.object({
  id: PersonaId, name: z.string(), role: z.string(), namesake: z.string(), blurb: z.string(), does: z.array(z.string()), color: z.string(),
});

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

type WriteOptions = { method: "POST" | "PUT"; body: unknown; operationKey: string };

export class ConsoleClient implements ConsoleApi {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  async request<T>(path: string, schema: z.ZodType<T>, options?: WriteOptions): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (options) {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = options.operationKey;
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
        method: options?.method ?? "GET", headers,
        ...(options ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch {
      if (options) throw new UnknownWriteOutcome(options.operationKey);
      throw new Error("API connection failed");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new ApiError(response.status, typeof body?.error === "string" ? body.error.slice(0, 300) : undefined);
    }
    return schema.parse(await response.json());
  }

  personas() { return this.request("/v1/personas", z.array(PersonaWire)); }
  activity(limit?: number) { return this.request(`/v1/activity${query({ limit })}`, z.array(ActivityItem)); }
  usage(q: UsageQuery = {}) { return this.request(`/v1/usage${query(q)}`, UsageSummary); }
  entries(q: EntriesQuery = {}) {
    return this.request(`/v1/usage/entries${query(q)}`, z.object({ entries: z.array(UsageEntry), cursor: z.string().optional() }));
  }
  inbox() { return this.request("/v1/inbox", z.array(InboxItemSchema)); }
  trail(id: string) { return this.request(`/v1/trails/${encodeURIComponent(id)}`, TrailDetailSchema); }
  async decide(trailId: string, input: { checkpoint: "A" | "B" | "C" | "spend"; verdict: Verdict; note?: string }, op: string) {
    const { checkpoint, ...rest } = input;
    const path = checkpoint === "spend" ? `/v1/spend/${encodeURIComponent(trailId)}/decide` : `/v1/trails/${encodeURIComponent(trailId)}/decide`;
    await this.request(path, z.object({ ok: z.literal(true) }), {
      method: "POST", body: checkpoint === "spend" ? rest : input, operationKey: op,
    });
  }
  async trailAction(trailId: string, action: TrailAction, input: { text?: string; reason?: string }, op: string) {
    await this.request(`/v1/trails/${encodeURIComponent(trailId)}/${action}`, z.object({ ok: z.literal(true) }), {
      method: "POST", body: input, operationKey: op,
    });
  }
  docs() { return this.request("/v1/docs", z.array(PolicyDoc)); }
  doc(path: string) { return this.request(`/v1/docs/${path.split("/").map(encodeURIComponent).join("/")}`, PolicyDoc); }
  drafts(status?: Draft["status"]) { return this.request(`/v1/drafts${query({ status })}`, z.array(Draft)); }
  draft(id: string) { return this.request(`/v1/drafts/${encodeURIComponent(id)}`, Draft); }
  createDraft(path: string, operationKey: string) {
    return this.request("/v1/drafts", Draft, { method: "POST", body: { path }, operationKey });
  }
  sendMessage(id: string, text: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/messages`, Draft, { method: "POST", body: { text }, operationKey });
  }
  updateContent(id: string, content: string, baseDigest: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/content`, Draft, {
      method: "PUT", body: { content, baseDigest }, operationKey,
    });
  }
  applyProposal(id: string, messageId: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/apply`, Draft, { method: "POST", body: { messageId }, operationKey });
  }
  publish(id: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/publish`, Draft, { method: "POST", body: {}, operationKey });
  }
  discard(id: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/discard`, Draft, { method: "POST", body: {}, operationKey });
  }
}
