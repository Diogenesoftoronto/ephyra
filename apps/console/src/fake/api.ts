// FakeApi: the deterministic ConsoleApi used by Storybook, tests and `?demo`. No network, no clocks, no randomness.
// It models the server's behaviour for the cases the console must handle: stale approvals (409), approvers only (403),
// an unavailable Velum model (503), and a policy document that moved before publish (409).
import {
  AreaSketch,
  PERSONAS,
  type AgentRun,
  type AgentRunEvent,
  type Draft,
  type DraftMessage,
  type Trail,
  type TrailEvent,
  type UsageEntry,
  type VoiceCapabilities, type VoiceAudioInput, type VoiceReplyInput, type VoiceSpeech, type VoiceTranscript, type VoiceReply,
  type TutorCapabilities, type TutorInput, type TutorReply,
  type InvestigationQuestion, type InvestigationAnswer,
} from "@ephyra/core";
import {
  ApiError,
  VoiceRequestError,
  type ConsoleApi,
  type EntriesPage,
  type EntriesQuery,
  type DraftView,
  type InboxEntry,
  type PolicyDocView,
  type RunsQuery,
  type SharedTrailAction,
  type TrailAction,
  type TrailDetail,
  type UsageQuery,
  type Verdict,
} from "../api.ts";
import { filterEntries, summarize } from "../lib/usage.ts";
import { hasBlocking } from "../lib/warnings.ts";
import { FORM_PREFIX } from "../lib/protocol.ts";
import { areaFormSpec, checkpointFormSpec } from "./specs.ts";
import { makeRuns, type RunBundle } from "./runs.ts";
import { replaceAreas, sketchesOf } from "./sketch.ts";
import { lintAutonomy, readAreaForm, upsertArea, type AreaForm } from "./autonomy.ts";
import {
  emptyDraft,
  fakeDigest,
  makeActivity,
  makeDocs,
  makeEvents,
  makeInbox,
  makeTrails,
  makeUsage,
  ME,
  STORY_NOW,
} from "./fixtures.ts";

export const VELUM_ENGINE = "notorganic-chat/velum-1";

export type FakeOptions = {
  now?: number;
  /** Method names that never settle, to show loading and working states. */
  hang?: ReadonlyArray<keyof ConsoleApi>;
  /** Method names that fail with the given error. */
  fail?: Partial<Record<keyof ConsoleApi, Error>>;
  /** Trail ids whose open checkpoint is stale: a decision on them answers 409. */
  staleTrails?: readonly string[];
  /** Trail ids that moved after their inbox item was made: the card is stale on arrival, and a reload re-binds it. */
  movedTrails?: readonly string[];
  /** When false, writes by this principal answer 403. */
  approver?: boolean;
  /** Exact authenticated actor used in the demo's comments and review claims. */
  principal?: string;
  velumUnavailable?: boolean;
  /** Publishing answers 409 as if the live document moved. */
  publishConflict?: boolean;
  /** Start with no trails, activity, usage, docs or drafts. */
  empty?: boolean;
  /** Seed an open autonomy.md draft that already holds a conversation with Velum. */
  seedConversation?: boolean;
  /** Pause between live run events. Infinity holds the stream where it is (for stable screenshots). Default 1200. */
  streamIntervalMs?: number;
  questions?: InvestigationQuestion[];
  rejectQuestionAnswers?: boolean;
};

const BILLING: AreaForm = {
  name: "billing",
  paths: ["src/billing/**", "src/invoices/**"],
  risk: "high",
  userFacing: true,
  checkpoints: { A: "advisory", B: "advisory", C: "blocking" },
  landing: ["trail_ref"],
  watchSeconds: 7200,
  voxqMicrousd: 0,
};

export class FakeApi implements ConsoleApi {
  async tutorCapabilities(): Promise<TutorCapabilities> {
    await this.gate("tutorCapabilities");
    return { provider: null, model: null, maxCostMicrousd: null };
  }
  async explainTrail(_input: TutorInput, _op: string, _signal: AbortSignal): Promise<TutorReply> {
    throw new VoiceRequestError("demo", "This demo has no Tutor provider. Explore the Tutor stories for interaction fixtures.");
  }
  async voiceCapabilities(): Promise<VoiceCapabilities> {
    await this.gate("voiceCapabilities");
    return { provider: null, transcriptionModel: null, speechModel: null, voice: null, conversation: false,
      maxRecordingMs: 60000, maxAudioBytes: 4000000, maxSpeechChars: 3000, maxCostMicrousd: null };
  }
  async transcribe(_input: VoiceAudioInput, _op: string, _signal: AbortSignal): Promise<VoiceTranscript> {
    throw new VoiceRequestError("demo", "Demo mode does not record audio or call speech providers.");
  }
  async speak(_text: string, _op: string, _signal: AbortSignal): Promise<VoiceSpeech> {
    throw new VoiceRequestError("demo", "Demo mode does not generate speech.");
  }
  async voiceReply(_input: VoiceReplyInput, _op: string, _signal: AbortSignal): Promise<VoiceReply> {
    throw new VoiceRequestError("demo", "This demo has no voice model. Explore the Voice stories for interaction fixtures.");
  }
  readonly now: number;
  private trails: Trail[];
  private inboxItems: InboxEntry[];
  private events = new Map<string, TrailEvent[]>();
  private usageRows: UsageEntry[];
  private docList: PolicyDocView[];
  private draftMap = new Map<string, Draft>();
  private ops = new Map<string, unknown>();
  private trailOps = new Map<string, string>();
  private runBundles: RunBundle[];
  private released = new Map<string, number>();
  private refreshed = new Set<string>();
  private inboxReads = 0;
  private questionItems: InvestigationQuestion[];
  private tick = 0;
  private counter = 0;
  /** Every write that reached the fake, for tests: [method, args]. */
  readonly writes: Array<[string, unknown]> = [];

  constructor(private readonly options: FakeOptions = {}) {
    this.now = options.now ?? STORY_NOW;
    this.questionItems = structuredClone(options.questions ?? []);
    const empty = options.empty === true;
    this.trails = empty ? [] : makeTrails(this.now);
    this.inboxItems = empty ? [] : makeInbox(this.trails, this.now);
    this.usageRows = empty ? [] : makeUsage(this.trails, this.now);
    this.docList = empty ? [] : makeDocs();
    this.runBundles = empty ? [] : makeRuns(this.trails, this.now);
    for (const t of this.trails) this.events.set(t.id, makeEvents(t, this.now));
    if (!empty) this.seedDrafts(options.seedConversation !== false);
    for (const id of options.movedTrails ?? []) {
      const t = this.trails.find((x) => x.id === id);
      if (t) {
        t.rev += 1;
        t.head = fakeDigest(`moved-${id}`).slice(0, 40);
      }
    }
  }

  async identity() {
    await this.gate("identity");
    return { principal: this.options.principal ?? ME, kind: "human" as const, approver: this.options.approver !== false };
  }
  async questions() {
    await this.gate("questions");
    return structuredClone(this.questionItems);
  }
  async question(trailId: string, questionId: string) {
    await this.gate("question");
    return structuredClone(this.questionItems.find((question) => question.id === questionId && question.trailId === trailId) ?? null);
  }
  async answerQuestion(trailId: string, questionId: string, input: InvestigationAnswer, operationKey: string) {
    await this.gate("answerQuestion");
    const question = this.questionItems.find((item) => item.id === questionId && item.trailId === trailId);
    if (!question || question.recipient?.did !== (this.options.principal ?? ME)) throw new ApiError(403);
    if (question.answer) {
      if (question.answer.text !== input.text.trim()) throw new ApiError(409);
      return structuredClone(question);
    }
    if (question.status !== "awaiting_answer") throw new ApiError(409);
    this.writes.push(["answerQuestion", { trailId, questionId, input, operationKey }]);
    question.answer = { text: input.text.trim(), by: question.recipient.id, at: this.stamp(), accepted: !this.options.rejectQuestionAnswers };
    question.status = question.answer.accepted ? "answered" : "rejected";
    question.checks.push({ phase: "answer", model: "fixture/not-a-live-model", accepted: question.answer.accepted,
      request: { fixture: true }, response: { fixture: true } });
    return structuredClone(question);
  }

  // ── plumbing ──
  private async gate(name: keyof ConsoleApi): Promise<void> {
    if (this.options.hang?.includes(name)) await new Promise(() => undefined);
    const failure = this.options.fail?.[name];
    if (failure) throw failure;
    await Promise.resolve();
  }

  private requireApprover(): void {
    if (this.options.approver === false)
      throw new ApiError(403, "this Not Organic account is not an approver on this deployment");
  }

  private once<T>(op: string, run: () => T): T {
    if (this.ops.has(op)) return this.ops.get(op) as T;
    const result = run();
    this.ops.set(op, result);
    return result;
  }

  private stamp(): string {
    this.tick += 1;
    return new Date(this.now + this.tick * 20_000).toISOString();
  }

  private mid(): string {
    this.counter += 1;
    return `m-${String(this.counter).padStart(3, "0")}`;
  }

  // ── reads ──
  async personas() {
    await this.gate("personas");
    return structuredClone([...PERSONAS]);
  }
  async activity(limit = 50) {
    await this.gate("activity");
    return structuredClone(makeActivityFor(this)).slice(0, limit);
  }

  async usage(q: UsageQuery = {}) {
    await this.gate("usage");
    const to = q.to ?? new Date(this.now).toISOString();
    const from =
      q.from ?? new Date(Math.floor(this.now / 86_400_000) * 86_400_000 - 6 * 86_400_000).toISOString();
    const rows = filterEntries(this.usageRows, { ...q, from, to });
    const meta = this.trails.map((t) => ({
      trailId: t.id,
      short: t.short,
      title: t.title,
      budget: {
        spendMicrousdUsed: t.budget.spendMicrousdUsed,
        spendMicrousdMax: t.budget.spendMicrousdMax,
        tokensUsed: t.budget.tokensUsed,
        tokensMax: t.budget.tokensMax,
      },
    }));
    return summarize(rows, from, to, meta);
  }

  async entries(q: EntriesQuery = {}): Promise<EntriesPage> {
    await this.gate("entries");
    const from = q.from ?? new Date(this.now - 7 * 86_400_000).toISOString();
    const rows = filterEntries(this.usageRows, { ...q, from, to: q.to ?? new Date(this.now).toISOString() });
    const start = q.cursor ? Number(q.cursor) : 0;
    const limit = q.limit ?? 25;
    const next = start + limit;
    return structuredClone({
      entries: rows.slice(start, next),
      ...(next < rows.length ? { cursor: String(next) } : {}),
    });
  }

  async inbox() {
    await this.gate("inbox");
    this.inboxReads += 1;
    if (this.inboxReads > 1) for (const id of this.options.movedTrails ?? []) this.rebind(id);
    return structuredClone(this.inboxItems);
  }

  private rebind(trailId: string): void {
    const t = this.trails.find((x) => x.id === trailId);
    if (!t) return;
    this.inboxItems = this.inboxItems.map((i) =>
      i.trailId === trailId
        ? { ...i, bound: { ...i.bound, rev: t.rev, ...(t.head ? { head: t.head } : {}) } }
        : i,
    );
  }

  private bundle(id: string): RunBundle {
    const b = this.runBundles.find((x) => x.run.id === id);
    if (!b) throw new ApiError(404, "not found");
    return b;
  }

  private visibleEvents(b: RunBundle): AgentRunEvent[] {
    return [...b.events, ...b.tail.slice(0, this.released.get(b.run.id) ?? 0)];
  }

  async runs(q: RunsQuery = {}): Promise<AgentRun[]> {
    await this.gate("runs");
    const rank = (r: AgentRun) => (r.status === "running" ? 0 : 1);
    return structuredClone(
      this.runBundles
        .map((b) => b.run)
        .filter((r) => (!q.trail || r.trailId === q.trail) && (!q.status || r.status === q.status))
        .sort((a, b) => rank(a) - rank(b) || (a.startedAt < b.startedAt ? 1 : -1))
        .slice(0, q.limit ?? 100),
    );
  }

  async run(id: string) {
    await this.gate("run");
    return structuredClone(this.bundle(id).run);
  }

  async runEvents(id: string, after?: number) {
    await this.gate("runEvents");
    return structuredClone(
      this.visibleEvents(this.bundle(id)).filter((e) => after === undefined || e.seq > after),
    );
  }

  async watchRun(
    id: string,
    after: number | undefined,
    onEvents: (events: AgentRunEvent[]) => void,
    signal: AbortSignal,
    onRun?: (run: AgentRun) => void,
  ) {
    await this.gate("watchRun");
    const b = this.bundle(id);
    if (!signal.aborted) onRun?.(structuredClone(b.run));
    const interval = this.options.streamIntervalMs ?? 1200;
    let cursor = after ?? -1;
    const sendNew = () => {
      const fresh = this.visibleEvents(b).filter((e) => e.seq > cursor);
      if (fresh.length) {
        cursor = fresh.at(-1)!.seq;
        onEvents(structuredClone(fresh));
      }
    };
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const t = ms === Infinity ? undefined : setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    sendNew();
    // Like the server: a closed run ends the stream with its status once everything it wrote has been sent.
    if (b.run.status !== "running") return b.run.status;
    while (!signal.aborted) {
      if ((this.released.get(id) ?? 0) < b.tail.length) {
        await wait(interval);
        if (signal.aborted) return null;
        this.released.set(id, (this.released.get(id) ?? 0) + 1);
        sendNew();
      } else await wait(Infinity);
    }
    return null;
  }

  async trail(id: string): Promise<TrailDetail> {
    await this.gate("trail");
    const trail = this.trails.find((t) => t.id === id);
    if (!trail) throw new ApiError(404, "not found");
    return structuredClone({ trail, events: this.events.get(id) ?? [] });
  }

  private trailOpKey(id: string, action: TrailAction, op: string): string {
    return JSON.stringify([this.options.principal ?? ME, id, action, op]);
  }

  async trailOperation(id: string, action: SharedTrailAction, operationKey: string) {
    await this.gate("trailOperation");
    if (!this.trails.some((t) => t.id === id)) throw new ApiError(404, "not found");
    return { status: this.trailOps.has(this.trailOpKey(id, action, operationKey)) ? "recorded" as const : "not_found" as const };
  }

  async docs() {
    await this.gate("docs");
    return structuredClone(this.docList.map((d) => this.withMap(d)));
  }
  async doc(path: string) {
    await this.gate("doc");
    const doc = this.docList.find((d) => d.path === path);
    if (!doc) throw new ApiError(404, "not found");
    return structuredClone(this.withMap(doc));
  }
  async drafts(status?: Draft["status"]) {
    await this.gate("drafts");
    return structuredClone(
      [...this.draftMap.values()]
        .filter((d) => !status || d.status === status)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((d) => this.withMap(d)),
    );
  }
  async draft(id: string) {
    await this.gate("draft");
    return structuredClone(this.withMap(this.get(id)));
  }

  /** The server adds the application map to the autonomy document and its drafts. */
  private withMap<T extends { kind: string; content: string }>(x: T): T & { sketches?: AreaSketch[] } {
    return x.kind === "autonomy" ? { ...x, sketches: sketchesOf(x.content) } : x;
  }

  // ── writes ──
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
    await this.gate("decide");
    this.requireApprover();
    return this.once(op, () => {
      const item = this.inboxItems.find(
        (i) =>
          i.trailId === trailId &&
          (input.checkpoint === "spend" ? i.kind === "spend" : i.checkpoint === input.checkpoint),
      );
      if (
        input.bound &&
        (!item ||
          input.bound.rev !== item.bound.rev ||
          input.bound.head !== item.bound.head ||
          input.bound.proofDigest !== item.bound.proofDigest)
      )
        throw new ApiError(409, "the reviewed item changed");
      const trail = this.trails.find((t) => t.id === trailId);
      if (!trail) throw new ApiError(404, "not found");
      if (trail.state === "handed_off") throw new ApiError(409, "release the review claim before deciding");
      if (this.options.staleTrails?.includes(trailId) && !this.refreshed.has(trailId)) {
        this.refreshBinding(trail);
        throw new ApiError(409, "approval is stale");
      }
      this.writes.push(["decide", { trailId, ...input }]);
      const decision = {
        by: "human" as const,
        who: this.options.principal ?? ME,
        at: this.stamp(),
        verdict: input.verdict,
        ...(input.note ? { note: input.note } : {}),
      };
      if (input.checkpoint === "spend") {
        trail.checkpoints.spend = [...trail.checkpoints.spend, decision];
        delete trail.pendingSpend;
      } else trail.checkpoints[input.checkpoint] = decision;
      if (input.verdict === "approve")
        trail.state = ({ A: "reproducing", B: "patching", C: "landing", spend: trail.state } as const)[
          input.checkpoint
        ];
      if (input.verdict === "reject") trail.state = "abandoned";
      trail.rev += 1;
      this.inboxItems = this.inboxItems.filter(
        (i) => !(i.trailId === trailId && (i.checkpoint === input.checkpoint || i.kind === input.checkpoint)),
      );
      if (input.checkpoint === "spend")
        this.inboxItems = this.inboxItems.filter((i) => !(i.trailId === trailId && i.kind === "spend"));
    });
  }

  async trailAction(
    trailId: string,
    action: TrailAction,
    input: { text?: string; reason?: string },
    op: string,
  ) {
    await this.gate("trailAction");
    this.requireApprover();
    const principal = this.options.principal ?? ME;
    const key = this.trailOpKey(trailId, action, op);
    const intent = JSON.stringify({ text: input.text, reason: input.reason });
    const recorded = this.trailOps.get(key);
    if (recorded !== undefined) {
      if (recorded !== intent) throw new ApiError(409, "operation key was already used for a different action body");
      return;
    }
    {
      const trail = this.trails.find((t) => t.id === trailId);
      if (!trail) throw new ApiError(404, "not found");
      if (action === "comment" && (!input.text?.trim() || input.text.length > 4000))
        throw new ApiError(400, "comment must contain 1 to 4,000 characters");
      if (action === "claim" && (!["hypothesised", "planned", "ready"].includes(trail.state) || trail.owner?.kind === "human"))
        throw new ApiError(409, "a review can only be claimed at an unclaimed checkpoint");
      if (action === "release" && (trail.state !== "handed_off" || trail.owner?.kind !== "human" || trail.owner.id !== principal))
        throw new ApiError(409, "only the person who claimed the review can release it");
      if (trail.state === "handed_off" && action !== "comment" && action !== "release")
        throw new ApiError(409, "release the review claim before changing the quest");
      this.writes.push(["trailAction", { trailId, action, ...input }]);
      if (action === "park") {
        trail.resumeTo = trail.state;
        trail.state = "parked";
      }
      if (action === "resume") {
        trail.state = trail.resumeTo ?? "researching";
        delete trail.resumeTo;
      }
      if (action === "claim") {
        trail.owner = { kind: "human", id: principal };
        trail.resumeTo = trail.state;
        trail.state = "handed_off";
      }
      if (action === "release") {
        trail.state = trail.resumeTo!;
        delete trail.resumeTo;
        delete trail.owner;
      }
      const list = this.events.get(trailId) ?? [];
      const body =
        action === "comment"
          ? { type: "human_comment", data: { text: input.text ?? "", isRequest: false } }
          : action === "claim"
            ? { type: "claimed_by_human", data: {} }
            : action === "release"
              ? { type: "released_by_human", data: {} }
              : action === "park"
                ? { type: "parked", data: { reason: input.reason ?? "Parked from the console." } }
                : { type: "resumed", data: {} };
      list.push({
        schema: 1,
        id: `${trailId.slice(0, 8)}-0000-4000-8000-${String(900 + list.length).padStart(12, "0")}`,
        trail: trailId,
        rev: trail.rev,
        at: this.stamp(),
        actor: { kind: "human", id: principal },
        ...body,
      } as TrailEvent);
      this.events.set(trailId, list);
      this.inboxItems = this.inboxItems.map((i) =>
        i.trailId === trailId ? { ...i, state: trail.state } : i,
      );
      this.trailOps.set(key, intent);
    }
  }

  async updateSketches(id: string, sketches: AreaSketch[], baseDigest: string, op: string) {
    await this.gate("updateSketches");
    this.requireApprover();
    return structuredClone(
      this.once(op, () => {
        const draft = this.get(id);
        if (draft.status !== "open") throw new ApiError(409, `draft is ${draft.status}`);
        if (draft.kind !== "autonomy")
          throw new ApiError(400, "the application map only applies to the autonomy document");
        if (baseDigest !== draft.baseDigest)
          throw new ApiError(409, "this draft is based on a different version of the document");
        if (hasBlocking(lintAutonomy(draft.content)))
          throw new ApiError(409, "the draft text has errors; fix it before editing the map");
        const parsed = AreaSketch.array().max(100).safeParse(sketches);
        if (!parsed.success) throw new ApiError(400, "invalid request body");
        this.writes.push(["updateSketches", { id }]);
        draft.content = replaceAreas(draft.content, parsed.data);
        draft.warnings = lintAutonomy(draft.content);
        draft.updatedAt = this.stamp();
        return this.withMap(draft);
      }),
    );
  }

  async createDraft(path: string, op: string) {
    await this.gate("createDraft");
    return structuredClone(
      this.once(op, () => {
        const doc = this.docList.find((d) => d.path === path);
        if (!doc) throw new ApiError(404, "not found");
        const draft = {
          ...emptyDraft(`d-${this.draftMap.size + 1}`, doc, this.now),
          createdAt: this.stamp(),
          updatedAt: this.stamp(),
        };
        this.draftMap.set(draft.id, draft);
        this.writes.push(["createDraft", { path }]);
        return this.withMap(draft);
      }),
    );
  }

  async sendMessage(id: string, text: string, op: string) {
    await this.gate("sendMessage");
    this.requireApprover();
    return structuredClone(
      this.once(op, () => {
        const draft = this.get(id);
        this.writes.push(["sendMessage", { id, text }]);
        draft.messages.push({ id: op, at: this.stamp(), role: "human", author: ME, text });
        // Like the server: an unavailable model is a system message in the draft, never a made-up reply.
        draft.messages.push(
          this.options.velumUnavailable
            ? {
                id: this.mid(),
                at: this.stamp(),
                role: "system",
                text: "Velum is unavailable: Unverified, no draft model is configured. Nothing was drafted.",
              }
            : this.velumReply(draft, text),
        );
        draft.updatedAt = this.stamp();
        return this.withMap(draft);
      }),
    );
  }

  async updateContent(id: string, content: string, baseDigest: string, op: string) {
    await this.gate("updateContent");
    this.requireApprover();
    return structuredClone(
      this.once(op, () => {
        const draft = this.get(id);
        if (baseDigest !== draft.baseDigest)
          throw new ApiError(409, "the document changed since this draft started");
        this.writes.push(["updateContent", { id }]);
        draft.content = content;
        draft.warnings = draft.kind === "autonomy" ? lintAutonomy(content) : [];
        draft.updatedAt = this.stamp();
        return this.withMap(draft);
      }),
    );
  }

  async applyProposal(id: string, messageId: string, op: string) {
    await this.gate("applyProposal");
    this.requireApprover();
    return structuredClone(
      this.once(op, () => {
        const draft = this.get(id);
        const proposal = draft.messages.find((m) => m.id === messageId)?.proposal;
        if (!proposal) throw new ApiError(404, "no proposal on that message");
        if (hasBlocking(proposal.warnings))
          throw new ApiError(409, "that proposal has errors and cannot be applied");
        this.writes.push(["applyProposal", { id, messageId }]);
        draft.content = proposal.content;
        draft.warnings = proposal.warnings;
        draft.updatedAt = this.stamp();
        return this.withMap(draft);
      }),
    );
  }

  async publish(id: string, op: string) {
    await this.gate("publish");
    this.requireApprover();
    return structuredClone(
      this.once(op, () => {
        const draft = this.get(id);
        const doc = this.docList.find((d) => d.path === draft.path);
        if (this.options.publishConflict || (doc && doc.digest !== draft.baseDigest)) {
          throw new ApiError(409, "the policy document changed since this draft started");
        }
        if (hasBlocking(draft.warnings))
          throw new ApiError(409, "the draft has errors; fix them before publishing");
        this.writes.push(["publish", { id }]);
        draft.status = "published";
        draft.updatedAt = this.stamp();
        draft.published = {
          ref: `refs/ephyra/policy/${draft.id}`,
          commit: fakeDigest(draft.content).slice(0, 40),
          by: ME,
          at: draft.updatedAt,
        };
        return this.withMap(draft);
      }),
    );
  }

  async discard(id: string, op: string) {
    await this.gate("discard");
    this.requireApprover();
    return structuredClone(
      this.once(op, () => {
        const draft = this.get(id);
        this.writes.push(["discard", { id }]);
        draft.status = "discarded";
        draft.updatedAt = this.stamp();
        return this.withMap(draft);
      }),
    );
  }

  // ── internals ──
  /** Model a trail that moved after the inbox item was made: a new head and revision, so a reload shows a fresh binding. */
  private refreshBinding(trail: Trail): void {
    this.refreshed.add(trail.id);
    trail.rev += 1;
    trail.head = fakeDigest(`head-${trail.id}-${trail.rev}`).slice(0, 40);
    this.rebind(trail.id);
  }

  /** For makeActivityFor. */
  snapshot() {
    return { trails: this.trails, now: this.now, empty: this.options.empty === true };
  }

  private get(id: string): Draft {
    const draft = this.draftMap.get(id);
    if (!draft) throw new ApiError(404, "not found");
    return draft;
  }

  private seedDrafts(withConversation: boolean): void {
    const autonomy = this.docList.find((d) => d.path === "autonomy.md")!;
    const intent = this.docList.find((d) => d.path === "intents/search.md")!;
    const thresholds = this.docList.find((d) => d.path === "thresholds.yaml")!;
    const main = emptyDraft("d-1", autonomy, this.now);
    if (withConversation) {
      main.messages.push({
        id: "m-seed-1",
        at: new Date(this.now - 38 * 60_000).toISOString(),
        role: "human",
        author: ME,
        text: "Add an area for billing.",
      });
      main.messages.push(this.velumReply(main, "Add an area for billing."));
      main.updatedAt = new Date(this.now - 36 * 60_000).toISOString();
    }
    this.draftMap.set(main.id, main);
    const published = emptyDraft("d-2", thresholds, this.now, "did:web:sam.example");
    published.status = "published";
    published.updatedAt = new Date(this.now - 5 * 3600_000).toISOString();
    published.published = {
      ref: "refs/ephyra/policy/d-2",
      commit: "5b1e4c3a9d2f1a6b8e0c4d715b1e4c3a9d2f1a6b",
      by: "did:web:sam.example",
      at: published.updatedAt,
    };
    this.draftMap.set(published.id, published);
    const discarded = emptyDraft("d-3", intent, this.now);
    discarded.status = "discarded";
    discarded.updatedAt = new Date(this.now - 26 * 3600_000).toISOString();
    this.draftMap.set(discarded.id, discarded);
    this.counter = 100;
  }

  private velumReply(draft: Draft, text: string): DraftMessage {
    const base: Omit<DraftMessage, "text"> = {
      id: this.mid(),
      at: this.stamp(),
      role: "persona",
      persona: "velum",
      usage: { engine: VELUM_ENGINE, tokens: 1800, costMicrousd: 9000 },
    };
    if (draft.kind !== "autonomy") return this.otherDocReply(draft, text, base);
    if (text.startsWith(FORM_PREFIX)) {
      const form = parseFormMessage(text);
      if (!form)
        return { ...base, text: "I could not read those values, so I changed nothing. Try the form again." };
      const content = upsertArea(draft.content, form);
      return {
        ...base,
        text: `Done. I set the ${form.name} area from the form. Check the changes before you publish.`,
        proposal: {
          content,
          summary: `Set the ${form.name} area from the form.`,
          warnings: lintAutonomy(content),
        },
      };
    }
    if (/never land|fix itself|can fix|trust|autonomy level/i.test(text)) {
      const next = sketchesOf(draft.content).map((a) =>
        a.name === "payments"
          ? { ...a, level: "propose" as const }
          : a.name === "marketing-site"
            ? { ...a, level: "auto" as const }
            : a,
      );
      return this.sketchReply(
        base,
        draft,
        next,
        "Payments stays at Propose, so a person approves every step. The marketing site moves up to Auto-land.",
        "Payments at Propose; the marketing site at Auto-land.",
      );
    }
    if (/billing/i.test(text)) {
      const sketch: AreaSketch = {
        name: "billing",
        intent: "Invoices, tax summaries and refunds. Money is counted here but not moved.",
        paths: BILLING.paths,
        risk: "high",
        level: "propose",
        userFacing: true,
      };
      const current = sketchesOf(draft.content).filter((a) => a.name !== "billing");
      const content = replaceAreas(draft.content, [...current, sketch]);
      return {
        ...base,
        text:
          "Billing handles money but not card data, so I made it high risk with C blocking. " +
          "Adjust anything in the form, or ask me to change it.",
        spec: areaFormSpec(
          BILLING,
          "Billing sits next to payments. Raise the risk to critical if invoices can move money.",
        ),
        proposal: {
          content,
          summary: "Add a billing area: high risk, Propose level, lands as a quest ref.",
          warnings: lintAutonomy(content),
          sketches: [...current, sketch],
        },
      };
    }
    if (/payments|blocking|checkpoint/i.test(text)) {
      const current = readAreaForm(draft.content, "payments");
      const area: AreaForm = {
        ...BILLING,
        name: "payments",
        paths: current?.paths ?? ["src/payments/**"],
        risk: "critical",
        checkpoints: { A: "blocking", B: "blocking", C: "blocking" },
      };
      const content = upsertArea(draft.content, area);
      return {
        ...base,
        text: "Here is payments with every checkpoint blocking. A person approves each step.",
        spec: checkpointFormSpec("payments", area.checkpoints),
        proposal: {
          content,
          summary: "Make A, B and C blocking for payments.",
          warnings: lintAutonomy(content),
        },
      };
    }
    if (/broken|invalid|severe/i.test(text)) {
      const content = `${draft.content.trimEnd()}\n\n## area: labs\npaths: src/labs/**\nrisk: severe\n`;
      return {
        ...base,
        text: "I added a labs area, but I am not sure about the risk word. The parser may reject it.",
        proposal: {
          content,
          summary: "Add a labs area with risk set to 'severe'.",
          warnings: lintAutonomy(content),
        },
      };
    }
    return {
      ...base,
      text: "I can change an area's paths, risk, checkpoints, landing or watch window. Which area, and what should change?",
    };
  }

  private sketchReply(
    base: Omit<DraftMessage, "text">,
    draft: Draft,
    sketches: AreaSketch[],
    text: string,
    summary: string,
  ): DraftMessage {
    const content = replaceAreas(draft.content, sketches);
    return { ...base, text, proposal: { content, summary, warnings: lintAutonomy(content), sketches } };
  }

  private otherDocReply(draft: Draft, text: string, base: Omit<DraftMessage, "text">): DraftMessage {
    if (draft.kind === "intent") {
      const content = `${draft.content.trimEnd()}\n${text.endsWith(".") ? text : `${text}.`}\n`;
      return {
        ...base,
        text: "I added that as a new line at the end of the intent.",
        proposal: { content, summary: "Append your sentence to the intent.", warnings: [] },
      };
    }
    return {
      ...base,
      text: "Thresholds are numbers per backend identity. Tell me which one to move, and by how much.",
    };
  }
}

function makeActivityFor(api: FakeApi) {
  const s = api.snapshot();
  return s.empty ? [] : makeActivity(s.trails, s.now);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

function parseFormMessage(text: string): AreaForm | null {
  try {
    const json = JSON.parse(text.slice(FORM_PREFIX.length).trim()) as {
      area?: Partial<AreaForm>;
      values?: Record<string, unknown>;
    };
    let a = json.area;
    if (json.values) {
      const fields = Object.entries(json.values).map(([path, value]) => ({
        match: /^area\.([a-z][a-z0-9-]{0,39})\.([a-z_]+)$/.exec(path),
        value,
      }));
      const name = fields[0]?.match?.[1];
      if (!name || fields.some((f) => f.match?.[1] !== name)) return null;
      const values = Object.fromEntries(fields.map((f) => [f.match![2], f.value]));
      const duration = typeof values.watch === "string" ? /^([1-9]\d*)(s|m|h|d)$/.exec(values.watch) : null;
      const budget =
        typeof values.voxq_budget_usd === "string"
          ? /^(\d+(?:\.\d+)?)\/month$/.exec(values.voxq_budget_usd)
          : null;
      a = {
        ...BILLING,
        name: typeof values.name === "string" ? values.name : name,
        ...(Array.isArray(values.paths) ? { paths: values.paths } : {}),
        ...(typeof values.risk === "string" ? { risk: values.risk as AreaForm["risk"] } : {}),
        ...(values.checkpoints ? { checkpoints: values.checkpoints as AreaForm["checkpoints"] } : {}),
        ...(Array.isArray(values.landing) ? { landing: values.landing } : {}),
        ...(typeof values.user_facing === "boolean" ? { userFacing: values.user_facing } : {}),
        ...(duration
          ? { watchSeconds: Number(duration[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[duration[2]!] ?? 1) }
          : {}),
        ...(budget ? { voxqMicrousd: Math.round(Number(budget[1]) * 1_000_000) } : {}),
      };
    }
    if (!a || typeof a.name !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(a.name)) return null;
    return { ...BILLING, ...a, paths: (a.paths ?? BILLING.paths).filter((p) => p.trim()) } as AreaForm;
  } catch {
    return null;
  }
}
