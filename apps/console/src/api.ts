import {
  ActivityItem,
  AgentRun,
  AgentRunEvent,
  AreaSketch,
  Draft,
  Effect,
  PersonaId,
  PolicyDoc,
  Trail,
  TrailEvent,
  UsageEntry,
  UsageSummary,
  VoiceCapabilities, VoiceTranscript, VoiceSpeech, VoiceReply,
  TutorCapabilities, TutorReply, type TutorInput,
  type VoiceAudioInput, type VoiceReplyInput,
  type Persona,
  InvestigationQuestion, type InvestigationAnswer,
  PolicyActivationReceipt,
} from "@ephyra/core";
import { z } from "zod";

export class ApiError extends Error {
  /** `detail` is the server's own `{ error }` text; it is shown as text, never as markup. */
  constructor(
    readonly status: number,
    readonly detail?: string,
  ) {
    super(
      status === 409 ? "This item changed. Refresh before trying again." : `API request failed (${status})`,
    );
  }
}

/** An interrupted mutation may have succeeded. Reconcile its operation key before any retry. */
export class UnknownWriteOutcome extends Error {
  constructor(readonly operationKey: string) {
    super("The write outcome is unknown. Reconcile before retrying.");
  }
}

export class VoiceRequestError extends Error {
  constructor(readonly code: string, message: string, readonly operationKey?: string) { super(message); }
}

// `InboxItem` is a type in core (ports.ts) with no schema, so the console validates the wire shape itself.
export const InboxItemSchema = z.object({
  trailId: z.string(),
  short: z.string(),
  title: z.string(),
  area: z.string(),
  risk: z.enum(["low", "medium", "high", "critical"]),
  severity: z.number(),
  state: z.string(),
  bound: z.object({ rev: z.number().int(), head: z.string().optional(), proofDigest: z.string().optional() }),
  landingUrl: z.string().optional(),
  evidenceIndex: z.string().optional(),
  kind: z.enum(["checkpoint", "spend", "parked", "notice"]),
  checkpoint: z.enum(["A", "B", "C"]).optional(),
  blocking: z.boolean(),
  shadowVerdict: z.enum(["approve", "revise", "reject"]).optional(),
  artefact: z.object({ path: z.string(), summary: z.string() }),
  createdAt: z.string(),
});
export type InboxEntry = z.infer<typeof InboxItemSchema>;

export const TrailDetailSchema = z.object({
  trail: Trail,
  events: z.array(TrailEvent),
  artefacts: z.array(z.object({ path: z.string(), content: z.string().nullable() })).optional(),
  /** What each transition asked the engine to do, with the event that caused it. Absent on servers that keep no history. */
  effects: z.array(z.object({ cause: z.string(), effect: Effect })).optional(),
});
export type TrailDetail = z.infer<typeof TrailDetailSchema>;

export type UsageQuery = {
  from?: string;
  to?: string;
  persona?: PersonaId | "unattributed";
  engine?: string;
  trail?: string;
};
export type EntriesQuery = UsageQuery & { cursor?: string; limit?: number };
export type EntriesPage = { entries: UsageEntry[]; cursor?: string };
export type Verdict = "approve" | "revise" | "reject";
export type RunsQuery = { trail?: string; status?: AgentRun["status"]; limit?: number };
/** The server adds `sketches` (the application map) next to the core shapes on the autonomy document and its drafts. */
export const PolicyDocView = PolicyDoc.extend({ sketches: z.array(AreaSketch).optional() });
export type PolicyDocView = z.infer<typeof PolicyDocView>;
export const DraftView = Draft.extend({ sketches: z.array(AreaSketch).optional() });
export type DraftView = z.infer<typeof DraftView>;
/** One decoded SSE frame: a run event, or the terminal `end` frame with the run's final status. */
export type RunFrame = { kind: "event"; event: AgentRunEvent } | { kind: "state"; run: AgentRun }
  | { kind: "end"; status: AgentRun["status"] };
export type TrailAction = "comment" | "claim" | "release" | "park" | "resume";
export type SharedTrailAction = Extract<TrailAction, "comment" | "claim" | "release">;
export const TrailOperation = z.object({ status: z.enum(["recorded", "not_found"]) });
export type TrailOperation = z.infer<typeof TrailOperation>;
export type ActivatePolicyInput = { expectedCommit: string; expectedDigest: string; expectedActive: string | null };

/**
 * Everything the console needs from the server. `ConsoleClient` speaks HTTP; `FakeApi` (src/fake) is the
 * deterministic implementation used by Storybook, tests and `?demo`. Every write takes an operation key.
 */
export const SessionInfo = z.object({
  alias: z.string().optional(),
  principal: z.string(),
  kind: z.enum(["service", "human"]),
  approver: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;
export const BrowserSession = z.object({ signIn: z.boolean(), identity: SessionInfo.nullable() });

export interface ConsoleApi {
  tutorCapabilities(): Promise<TutorCapabilities>;
  explainTrail(input: TutorInput, op: string, signal: AbortSignal): Promise<TutorReply>;
  voiceCapabilities(): Promise<VoiceCapabilities>;
  transcribe(input: VoiceAudioInput, op: string, signal: AbortSignal): Promise<VoiceTranscript>;
  speak(text: string, op: string, signal: AbortSignal): Promise<VoiceSpeech>;
  voiceReply(input: VoiceReplyInput, op: string, signal: AbortSignal): Promise<VoiceReply>;
  identity(): Promise<SessionInfo>;
  personas(): Promise<Persona[]>;
  activity(limit?: number): Promise<ActivityItem[]>;
  usage(query?: UsageQuery): Promise<UsageSummary>;
  entries(query?: EntriesQuery): Promise<EntriesPage>;
  inbox(): Promise<InboxEntry[]>;
  trails(): Promise<Trail[]>;
  questions(): Promise<InvestigationQuestion[]>;
  question(trailId: string, questionId: string): Promise<InvestigationQuestion | null>;
  answerQuestion(trailId: string, questionId: string, input: InvestigationAnswer, operationKey: string): Promise<InvestigationQuestion>;
  trail(id: string, signal?: AbortSignal): Promise<TrailDetail>;
  /** Check this authenticated principal's durable receipt without repeating a write. */
  trailOperation(id: string, action: SharedTrailAction, operationKey: string): Promise<TrailOperation>;
  decide(
    trailId: string,
    input: {
      checkpoint: "A" | "B" | "C" | "spend";
      verdict: Verdict;
      note?: string;
      bound?: InboxEntry["bound"];
    },
    op: string,
  ): Promise<void>;
  trailAction(
    trailId: string,
    action: TrailAction,
    input: { text?: string; reason?: string },
    op: string,
  ): Promise<void>;
  runs(query?: RunsQuery): Promise<AgentRun[]>;
  run(id: string): Promise<AgentRun>;
  runEvents(id: string, after?: number): Promise<AgentRunEvent[]>;
  /**
   * Follow a run live (SSE: `Accept: text/event-stream`). Resolves when the server ends the stream or `signal` aborts;
   * calls `onEvents` with each batch, oldest first. Callers resume with the last `seq` they saw (`?after=`).
   * Resolves with the final status when the server sent its `end` frame, otherwise `null` (the connection just closed).
   */
  watchRun(
    id: string,
    after: number | undefined,
    onEvents: (events: AgentRunEvent[]) => void,
    signal: AbortSignal,
    onRun?: (run: AgentRun) => void,
  ): Promise<AgentRun["status"] | null>;
  docs(): Promise<PolicyDocView[]>;
  doc(path: string): Promise<PolicyDocView>;
  drafts(status?: Draft["status"]): Promise<DraftView[]>;
  draft(id: string): Promise<DraftView>;
  createDraft(path: string, op: string): Promise<DraftView>;
  sendMessage(id: string, text: string, op: string): Promise<DraftView>;
  updateContent(id: string, content: string, baseDigest: string, op: string): Promise<DraftView>;
  /** Save the application map. The server renders it to the document (`sketchToArea` then `renderAutonomy`). */
  updateSketches(id: string, sketches: AreaSketch[], baseDigest: string, op: string): Promise<DraftView>;
  applyProposal(id: string, messageId: string, op: string): Promise<DraftView>;
  publish(id: string, op: string): Promise<DraftView>;
  activePolicy?(): Promise<PolicyActivationReceipt | null>;
  activatePolicy?(id: string, input: ActivatePolicyInput, op: string): Promise<PolicyActivationReceipt>;
  discard(id: string, op: string): Promise<DraftView>;
}

const PersonaWire = z.object({
  id: PersonaId,
  name: z.string(),
  role: z.string(),
  namesake: z.string(),
  blurb: z.string(),
  does: z.array(z.string()),
  color: z.string(),
});

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

const END_STATUSES = ["running", "done", "failed", "unavailable"] as const;

/**
 * One SSE frame to zero or one decoded frame. The server sends `event: run_event` frames (data is an `AgentRunEvent`),
 * `run_state` snapshots when links/status change, a final `end` frame, `retry:` lines and `: ping` comments.
 */
export function parseSseFrame(frame: string): RunFrame[] {
  const lines = frame.split("\n");
  const name = lines
    .find((l) => l.startsWith("event:"))
    ?.slice(6)
    .trim();
  const data = lines
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (!data) return [];
  try {
    const json: unknown = JSON.parse(data);
    if (name === "run_state") {
      const parsed = AgentRun.safeParse(json);
      return parsed.success ? [{ kind: "state", run: parsed.data }] : [];
    }
    if (name === "end") {
      const status = (json as { status?: unknown }).status;
      return typeof status === "string" && (END_STATUSES as readonly string[]).includes(status)
        ? [{ kind: "end", status: status as AgentRun["status"] }]
        : [];
    }
    const parsed = AgentRunEvent.safeParse(json);
    return parsed.success ? [{ kind: "event", event: parsed.data }] : [];
  } catch {
    return [];
  }
}

type WriteOptions = { method: "POST" | "PUT"; body: unknown; operationKey: string };

export class ConsoleClient implements ConsoleApi {
  constructor(
    readonly baseUrl: string,
    readonly token: string = "",
    readonly fetcher: typeof fetch = fetch,
    readonly principal?: string,
    readonly workspaceId?: string,
  ) {}

  private authHeaders(): Record<string, string> {
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(this.principal ? { "X-Ephyra-Principal": this.principal } : {}),
      ...(this.workspaceId ? { "X-Ephyra-Workspace": this.workspaceId } : {}),
    };
  }

  browserSession() { return this.request("/auth/session", BrowserSession); }
  async signOut() {
    const fetcher = this.fetcher;
    const response = await fetcher(new URL("/auth/logout", this.baseUrl), {
      method: "POST", credentials: "same-origin", headers: this.authHeaders(), cache: "no-store",
    });
    if (!response.ok) throw new ApiError(response.status, "Sign-out was not confirmed. Try again.");
  }

  voiceCapabilities() { return this.request("/v1/voice", VoiceCapabilities); }
  tutorCapabilities() { return this.request("/v1/tutor", TutorCapabilities); }
  explainTrail(input: TutorInput, op: string, signal: AbortSignal) { return this.voiceRequest("/v1/tutor/explain", TutorReply, input, op, signal); }
  private async voiceRequest<T>(path: string, schema: z.ZodType<T>, body: unknown, operationKey: string, signal: AbortSignal): Promise<T> {
    let res: Response;
    try {
      const fetcher = this.fetcher;
      res = await fetcher(new URL(path.startsWith("/") ? path : `/v1/voice/${path}`, this.baseUrl), {
        method: "POST", credentials: "same-origin", signal, body: JSON.stringify(body), headers: {
          ...this.authHeaders(), "Content-Type": "application/json", "Idempotency-Key": operationKey,
        },
      });
    } catch { throw new VoiceRequestError("reconciliation_required",
      "The connection ended before the model request finished. Check Usage before trying again.", operationKey); }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new VoiceRequestError(typeof json?.code === "string" ? json.code : res.status >= 500 ? "reconciliation_required" : "unavailable",
      typeof json?.error === "string" ? json.error.slice(0, 500) : `Model request failed (HTTP ${res.status}).`, operationKey);
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new VoiceRequestError("reconciliation_required",
      "The model response could not be read. Check Usage before trying again.", operationKey);
    return parsed.data;
  }
  transcribe(input: VoiceAudioInput, op: string, signal: AbortSignal) { return this.voiceRequest("transcribe", VoiceTranscript, input, op, signal); }
  speak(text: string, op: string, signal: AbortSignal) { return this.voiceRequest("speak", VoiceSpeech, { text }, op, signal); }
  voiceReply(input: VoiceReplyInput, op: string, signal: AbortSignal) { return this.voiceRequest("reply", VoiceReply, input, op, signal); }

  async request<T>(path: string, schema: z.ZodType<T>, options?: WriteOptions, signal?: AbortSignal): Promise<T> {
    const headers = this.authHeaders();
    if (options) {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = options.operationKey;
    }
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher(new URL(path, this.baseUrl), {
        method: options?.method ?? "GET",
        credentials: "same-origin",
        headers,
        cache: "no-store",
        ...(signal ? { signal } : {}),
        ...(options ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      if (options) throw new UnknownWriteOutcome(options.operationKey);
      if (signal?.aborted) throw error;
      throw new Error("API connection failed");
    }
    if (!response.ok) {
      if (options && response.status >= 500) throw new UnknownWriteOutcome(options.operationKey);
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new ApiError(
        response.status,
        typeof body?.error === "string" ? body.error.slice(0, 300) : undefined,
      );
    }
    try {
      return schema.parse(await response.json());
    } catch (error) {
      if (options) throw new UnknownWriteOutcome(options.operationKey);
      throw error;
    }
  }

  identity() {
    return this.request("/v1/me", SessionInfo);
  }
  personas() {
    return this.request("/v1/personas", z.array(PersonaWire));
  }
  activity(limit?: number) {
    return this.request(`/v1/activity${query({ limit })}`, z.array(ActivityItem));
  }
  usage(q: UsageQuery = {}) {
    return this.request(`/v1/usage${query(q)}`, UsageSummary);
  }
  entries(q: EntriesQuery = {}) {
    return this.request(
      `/v1/usage/entries${query(q)}`,
      z.object({ entries: z.array(UsageEntry), cursor: z.string().optional() }),
    );
  }
  inbox() {
    return this.request("/v1/inbox", z.array(InboxItemSchema));
  }
  trails() {
    return this.request("/v1/trails", z.array(Trail));
  }
  async questions() {
    const questions = await this.request("/v1/questions", z.array(InvestigationQuestion));
    if (this.workspaceId && questions.some((question) => question.workspaceId !== this.workspaceId)) throw new Error("Question workspace mismatch.");
    return questions;
  }
  async question(trailId: string, questionId: string) {
    const value = await this.request(`/v1/questions/${encodeURIComponent(trailId)}/${encodeURIComponent(questionId)}`, InvestigationQuestion.nullable());
    if (value && !this.matchesQuestion(value, trailId, questionId)) throw new Error("Question identity mismatch.");
    return value;
  }
  async answerQuestion(trailId: string, questionId: string, input: InvestigationAnswer, operationKey: string) {
    const value = await this.request(`/v1/questions/${encodeURIComponent(trailId)}/${encodeURIComponent(questionId)}/answer`, InvestigationQuestion,
      { method: "POST", body: input, operationKey });
    if (!this.matchesQuestion(value, trailId, questionId)) throw new UnknownWriteOutcome(operationKey);
    return value;
  }
  private matchesQuestion(value: InvestigationQuestion, trailId: string, questionId: string) {
    return value.trailId === trailId && value.id === questionId && (!this.workspaceId || value.workspaceId === this.workspaceId);
  }
  trail(id: string, signal?: AbortSignal) {
    return this.request(`/v1/trails/${encodeURIComponent(id)}`, TrailDetailSchema, undefined, signal);
  }
  trailOperation(id: string, action: SharedTrailAction, operationKey: string) {
    return this.request(
      `/v1/trails/${encodeURIComponent(id)}/operations/${action}${query({ key: operationKey })}`,
      TrailOperation,
    );
  }
  async decide(
    trailId: string,
    input: {
      checkpoint: "A" | "B" | "C" | "spend";
      verdict: Verdict;
      note?: string;
      bound?: InboxEntry["bound"];
    },
    op: string,
  ) {
    const { checkpoint, ...rest } = input;
    const path =
      checkpoint === "spend"
        ? `/v1/spend/${encodeURIComponent(trailId)}/decide`
        : `/v1/trails/${encodeURIComponent(trailId)}/decide`;
    await this.request(path, z.object({ ok: z.literal(true) }), {
      method: "POST",
      body: checkpoint === "spend" ? rest : input,
      operationKey: op,
    });
  }
  async trailAction(
    trailId: string,
    action: TrailAction,
    input: { text?: string; reason?: string },
    op: string,
  ) {
    await this.request(
      `/v1/trails/${encodeURIComponent(trailId)}/${action}`,
      z.object({ ok: z.literal(true) }),
      {
        method: "POST",
        body: input,
        operationKey: op,
      },
    );
  }
  runs(q: RunsQuery = {}) {
    return this.request(`/v1/runs${query(q)}`, z.array(AgentRun));
  }
  run(id: string) {
    return this.request(`/v1/runs/${encodeURIComponent(id)}`, AgentRun);
  }
  runEvents(id: string, after?: number) {
    return this.request(
      `/v1/runs/${encodeURIComponent(id)}/events${query({ after })}`,
      z.array(AgentRunEvent),
    );
  }
  async watchRun(
    id: string,
    after: number | undefined,
    onEvents: (events: AgentRunEvent[]) => void,
    signal: AbortSignal,
    onRun?: (run: AgentRun) => void,
  ) {
    const url = new URL(`/v1/runs/${encodeURIComponent(id)}/events${query({ after })}`, this.baseUrl);
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher(url, {
        headers: {
          ...this.authHeaders(),
          Accept: "text/event-stream",
        },
        credentials: "same-origin",
        signal,
      });
    } catch (error) {
      if (signal.aborted) return null;
      throw error;
    }
    if (!response.ok || !response.body) throw new ApiError(response.status);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += value;
        buffer = buffer.replace(/\r\n/g, "\n");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        const decoded = frames.flatMap(parseSseFrame);
        for (const frame of decoded) if (frame.kind === "state" && frame.run.id === id) onRun?.(frame.run);
        const events = decoded.flatMap((f) => (f.kind === "event" ? [f.event] : []));
        if (events.length) onEvents(events);
        const end = decoded.find((f) => f.kind === "end");
        if (end && end.kind === "end") return end.status;
      }
    } catch (error) {
      if (signal.aborted) return null;
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  docs() {
    return this.request("/v1/docs", z.array(PolicyDocView));
  }
  doc(path: string) {
    return this.request(`/v1/docs/${path.split("/").map(encodeURIComponent).join("/")}`, PolicyDocView);
  }
  drafts(status?: Draft["status"]) {
    return this.request(`/v1/drafts${query({ status })}`, z.array(DraftView));
  }
  draft(id: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}`, DraftView);
  }
  createDraft(path: string, operationKey: string) {
    return this.request("/v1/drafts", DraftView, { method: "POST", body: { path }, operationKey });
  }
  sendMessage(id: string, text: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/messages`, DraftView, {
      method: "POST",
      body: { text },
      operationKey,
    });
  }
  updateContent(id: string, content: string, baseDigest: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/content`, DraftView, {
      method: "PUT",
      body: { content, baseDigest },
      operationKey,
    });
  }
  updateSketches(id: string, sketches: AreaSketch[], baseDigest: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/sketches`, DraftView, {
      method: "PUT",
      body: { sketches, baseDigest },
      operationKey,
    });
  }
  applyProposal(id: string, messageId: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/apply`, DraftView, {
      method: "POST",
      body: { messageId },
      operationKey,
    });
  }
  publish(id: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/publish`, DraftView, {
      method: "POST",
      body: {},
      operationKey,
    });
  }
  activePolicy() {
    return this.request("/v1/policy/active", PolicyActivationReceipt.nullable());
  }
  activatePolicy(id: string, input: ActivatePolicyInput, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/activate`, PolicyActivationReceipt, {
      method: "POST", body: input, operationKey,
    });
  }
  discard(id: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/discard`, DraftView, {
      method: "POST",
      body: {},
      operationKey,
    });
  }
}
