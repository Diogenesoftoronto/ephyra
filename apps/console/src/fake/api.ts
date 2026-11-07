// FakeApi: the deterministic ConsoleApi used by Storybook, tests and `?demo`. No network, no clocks, no randomness.
// It models the server's behaviour for the cases the console must handle: stale approvals (409), approvers only (403),
// an unavailable Velum model (503), and a policy document that moved before publish (409).
import { PERSONAS, type Draft, type DraftMessage, type PolicyDoc, type Trail, type TrailEvent, type UsageEntry } from "@ephyra/core";
import {
  ApiError, type ConsoleApi, type EntriesPage, type EntriesQuery, type InboxEntry, type TrailAction, type TrailDetail, type UsageQuery,
  type Verdict,
} from "../api.ts";
import { filterEntries, summarize } from "../lib/usage.ts";
import { hasBlocking } from "../lib/warnings.ts";
import { FORM_PREFIX } from "../genui/form-message.ts";
import { areaFormSpec, checkpointFormSpec } from "./specs.ts";
import { lintAutonomy, readAreaForm, upsertArea, type AreaForm } from "./autonomy.ts";
import {
  emptyDraft, fakeDigest, makeActivity, makeDocs, makeEvents, makeInbox, makeTrails, makeUsage, ME, STORY_NOW,
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
  /** When false, writes by this principal answer 403. */
  approver?: boolean;
  velumUnavailable?: boolean;
  /** Publishing answers 409 as if the live document moved. */
  publishConflict?: boolean;
  /** Start with no trails, activity, usage, docs or drafts. */
  empty?: boolean;
  /** Seed an open autonomy.md draft that already holds a conversation with Velum. */
  seedConversation?: boolean;
};


const BILLING: AreaForm = {
  name: "billing", paths: ["src/billing/**", "src/invoices/**"], risk: "high", userFacing: true,
  checkpoints: { A: "advisory", B: "advisory", C: "blocking" }, landing: ["trail_ref"], watchSeconds: 7200, voxqMicrousd: 0,
};

export class FakeApi implements ConsoleApi {
  readonly now: number;
  private trails: Trail[];
  private inboxItems: InboxEntry[];
  private events = new Map<string, TrailEvent[]>();
  private usageRows: UsageEntry[];
  private docList: PolicyDoc[];
  private draftMap = new Map<string, Draft>();
  private ops = new Map<string, unknown>();
  private tick = 0;
  private counter = 0;
  /** Every write that reached the fake, for tests: [method, args]. */
  readonly writes: Array<[string, unknown]> = [];

  constructor(private readonly options: FakeOptions = {}) {
    this.now = options.now ?? STORY_NOW;
    const empty = options.empty === true;
    this.trails = empty ? [] : makeTrails(this.now);
    this.inboxItems = empty ? [] : makeInbox(this.trails, this.now);
    this.usageRows = empty ? [] : makeUsage(this.trails, this.now);
    this.docList = empty ? [] : makeDocs();
    for (const t of this.trails) this.events.set(t.id, makeEvents(t, this.now));
    if (!empty) this.seedDrafts(options.seedConversation !== false);
  }

  // ── plumbing ──
  private async gate(name: keyof ConsoleApi): Promise<void> {
    if (this.options.hang?.includes(name)) await new Promise(() => undefined);
    const failure = this.options.fail?.[name];
    if (failure) throw failure;
    await Promise.resolve();
  }

  private requireApprover(): void {
    if (this.options.approver === false) throw new ApiError(403, "this Not Organic account is not an approver on this deployment");
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

  private mid(): string { this.counter += 1; return `m-${String(this.counter).padStart(3, "0")}`; }

  // ── reads ──
  async personas() { await this.gate("personas"); return structuredClone([...PERSONAS]); }
  async activity(limit = 50) { await this.gate("activity"); return structuredClone(makeActivityFor(this)).slice(0, limit); }

  async usage(q: UsageQuery = {}) {
    await this.gate("usage");
    const to = q.to ?? new Date(this.now).toISOString();
    const from = q.from ?? new Date(Math.floor(this.now / 86_400_000) * 86_400_000 - 6 * 86_400_000).toISOString();
    const rows = filterEntries(this.usageRows, { ...q, from, to });
    const meta = this.trails.map((t) => ({ trailId: t.id, short: t.short, title: t.title,
      budget: { spendMicrousdUsed: t.budget.spendMicrousdUsed, spendMicrousdMax: t.budget.spendMicrousdMax,
        tokensUsed: t.budget.tokensUsed, tokensMax: t.budget.tokensMax } }));
    return summarize(rows, from, to, meta);
  }

  async entries(q: EntriesQuery = {}): Promise<EntriesPage> {
    await this.gate("entries");
    const from = q.from ?? new Date(this.now - 7 * 86_400_000).toISOString();
    const rows = filterEntries(this.usageRows, { ...q, from, to: q.to ?? new Date(this.now).toISOString() });
    const start = q.cursor ? Number(q.cursor) : 0;
    const limit = q.limit ?? 25;
    const next = start + limit;
    return structuredClone({ entries: rows.slice(start, next), ...(next < rows.length ? { cursor: String(next) } : {}) });
  }

  async inbox() { await this.gate("inbox"); return structuredClone(this.inboxItems); }

  async trail(id: string): Promise<TrailDetail> {
    await this.gate("trail");
    const trail = this.trails.find((t) => t.id === id);
    if (!trail) throw new ApiError(404, "not found");
    return structuredClone({ trail, events: this.events.get(id) ?? [] });
  }

  async docs() { await this.gate("docs"); return structuredClone(this.docList); }
  async doc(path: string) {
    await this.gate("doc");
    const doc = this.docList.find((d) => d.path === path);
    if (!doc) throw new ApiError(404, "not found");
    return structuredClone(doc);
  }
  async drafts(status?: Draft["status"]) {
    await this.gate("drafts");
    return structuredClone([...this.draftMap.values()].filter((d) => !status || d.status === status).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
  }
  async draft(id: string) { await this.gate("draft"); return structuredClone(this.get(id)); }

  // ── writes ──
  async decide(trailId: string, input: { checkpoint: "A" | "B" | "C" | "spend"; verdict: Verdict; note?: string }, op: string) {
    await this.gate("decide");
    this.requireApprover();
    return this.once(op, () => {
      const trail = this.trails.find((t) => t.id === trailId);
      if (!trail) throw new ApiError(404, "not found");
      if (this.options.staleTrails?.includes(trailId)) throw new ApiError(409, "approval is stale");
      this.writes.push(["decide", { trailId, ...input }]);
      const decision = { by: "human" as const, who: ME, at: this.stamp(), verdict: input.verdict, ...(input.note ? { note: input.note } : {}) };
      if (input.checkpoint === "spend") {
        trail.checkpoints.spend = [...trail.checkpoints.spend, decision];
        delete trail.pendingSpend;
      } else trail.checkpoints[input.checkpoint] = decision;
      if (input.verdict === "approve") trail.state = ({ A: "reproducing", B: "patching", C: "landing", spend: trail.state } as const)[input.checkpoint];
      if (input.verdict === "reject") trail.state = "abandoned";
      trail.rev += 1;
      this.inboxItems = this.inboxItems.filter((i) => !(i.trailId === trailId && (i.checkpoint === input.checkpoint || i.kind === input.checkpoint)));
      if (input.checkpoint === "spend") this.inboxItems = this.inboxItems.filter((i) => !(i.trailId === trailId && i.kind === "spend"));
    });
  }

  async trailAction(trailId: string, action: TrailAction, input: { text?: string; reason?: string }, op: string) {
    await this.gate("trailAction");
    this.requireApprover();
    return this.once(op, () => {
      const trail = this.trails.find((t) => t.id === trailId);
      if (!trail) throw new ApiError(404, "not found");
      this.writes.push(["trailAction", { trailId, action, ...input }]);
      if (action === "park") { trail.resumeTo = trail.state; trail.state = "parked"; }
      if (action === "resume") { trail.state = trail.resumeTo ?? "researching"; delete trail.resumeTo; }
      if (action === "claim") trail.owner = { kind: "human", id: ME };
      if (action === "release") delete trail.owner;
      trail.rev += 1;
      const list = this.events.get(trailId) ?? [];
      const body = action === "comment" ? { type: "human_comment", data: { text: input.text ?? "", isRequest: false } }
        : action === "claim" ? { type: "claimed_by_human", data: {} }
        : action === "release" ? { type: "released_by_human", data: {} }
        : action === "park" ? { type: "parked", data: { reason: input.reason ?? "Parked from the console." } }
        : { type: "resumed", data: {} };
      list.push({ schema: 1, id: `${trailId.slice(0, 8)}-0000-4000-8000-${String(900 + list.length).padStart(12, "0")}`, trail: trailId,
        rev: trail.rev, at: this.stamp(), actor: { kind: "human", id: ME }, ...body } as TrailEvent);
      this.events.set(trailId, list);
      this.inboxItems = this.inboxItems.map((i) => (i.trailId === trailId ? { ...i, state: trail.state } : i));
    });
  }

  async createDraft(path: string, op: string) {
    await this.gate("createDraft");
    return structuredClone(this.once(op, () => {
      const doc = this.docList.find((d) => d.path === path);
      if (!doc) throw new ApiError(404, "not found");
      const draft = { ...emptyDraft(`d-${this.draftMap.size + 1}`, doc, this.now), createdAt: this.stamp(), updatedAt: this.stamp() };
      this.draftMap.set(draft.id, draft);
      this.writes.push(["createDraft", { path }]);
      return draft;
    }));
  }

  async sendMessage(id: string, text: string, op: string) {
    await this.gate("sendMessage");
    this.requireApprover();
    return structuredClone(this.once(op, () => {
      const draft = this.get(id);
      if (this.options.velumUnavailable) throw new ApiError(503, "Unverified: no draft model is configured for Velum");
      this.writes.push(["sendMessage", { id, text }]);
      draft.messages.push({ id: this.mid(), at: this.stamp(), role: "human", author: ME, text });
      draft.messages.push(this.velumReply(draft, text));
      draft.updatedAt = this.stamp();
      return draft;
    }));
  }

  async updateContent(id: string, content: string, baseDigest: string, op: string) {
    await this.gate("updateContent");
    this.requireApprover();
    return structuredClone(this.once(op, () => {
      const draft = this.get(id);
      if (baseDigest !== draft.baseDigest) throw new ApiError(409, "the document changed since this draft started");
      this.writes.push(["updateContent", { id }]);
      draft.content = content;
      draft.warnings = draft.kind === "autonomy" ? lintAutonomy(content) : [];
      draft.updatedAt = this.stamp();
      return draft;
    }));
  }

  async applyProposal(id: string, messageId: string, op: string) {
    await this.gate("applyProposal");
    this.requireApprover();
    return structuredClone(this.once(op, () => {
      const draft = this.get(id);
      const proposal = draft.messages.find((m) => m.id === messageId)?.proposal;
      if (!proposal) throw new ApiError(404, "no proposal on that message");
      if (hasBlocking(proposal.warnings)) throw new ApiError(409, "that proposal has errors and cannot be applied");
      this.writes.push(["applyProposal", { id, messageId }]);
      draft.content = proposal.content;
      draft.warnings = proposal.warnings;
      draft.updatedAt = this.stamp();
      return draft;
    }));
  }

  async publish(id: string, op: string) {
    await this.gate("publish");
    this.requireApprover();
    return structuredClone(this.once(op, () => {
      const draft = this.get(id);
      const doc = this.docList.find((d) => d.path === draft.path);
      if (this.options.publishConflict || (doc && doc.digest !== draft.baseDigest)) {
        throw new ApiError(409, "the policy document changed since this draft started");
      }
      if (hasBlocking(draft.warnings)) throw new ApiError(409, "the draft has errors; fix them before publishing");
      this.writes.push(["publish", { id }]);
      draft.status = "published";
      draft.updatedAt = this.stamp();
      draft.published = { ref: `refs/ephyra/policy/${draft.id}`, commit: fakeDigest(draft.content).slice(0, 40), by: ME, at: draft.updatedAt };
      return draft;
    }));
  }

  async discard(id: string, op: string) {
    await this.gate("discard");
    this.requireApprover();
    return structuredClone(this.once(op, () => {
      const draft = this.get(id);
      this.writes.push(["discard", { id }]);
      draft.status = "discarded";
      draft.updatedAt = this.stamp();
      return draft;
    }));
  }

  // ── internals ──
  /** For makeActivityFor. */
  snapshot() { return { trails: this.trails, now: this.now, empty: this.options.empty === true }; }

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
      main.messages.push({ id: "m-seed-1", at: new Date(this.now - 38 * 60_000).toISOString(), role: "human", author: ME, text: "Add an area for billing." });
      main.messages.push(this.velumReply(main, "Add an area for billing."));
      main.updatedAt = new Date(this.now - 36 * 60_000).toISOString();
    }
    this.draftMap.set(main.id, main);
    const published = emptyDraft("d-2", thresholds, this.now, "did:web:sam.example");
    published.status = "published";
    published.updatedAt = new Date(this.now - 5 * 3600_000).toISOString();
    published.published = { ref: "refs/ephyra/policy/d-2", commit: "5b1e4c3a9d2f1a6b8e0c4d715b1e4c3a9d2f1a6b",
      by: "did:web:sam.example", at: published.updatedAt };
    this.draftMap.set(published.id, published);
    const discarded = emptyDraft("d-3", intent, this.now);
    discarded.status = "discarded";
    discarded.updatedAt = new Date(this.now - 26 * 3600_000).toISOString();
    this.draftMap.set(discarded.id, discarded);
    this.counter = 100;
  }

  private velumReply(draft: Draft, text: string): DraftMessage {
    const base: Omit<DraftMessage, "text"> = {
      id: this.mid(), at: this.stamp(), role: "persona", persona: "velum",
      usage: { engine: VELUM_ENGINE, tokens: 1800, costMicrousd: 9000 },
    };
    if (draft.kind !== "autonomy") return this.otherDocReply(draft, text, base);
    if (text.startsWith(FORM_PREFIX)) {
      const form = parseFormMessage(text);
      if (!form) return { ...base, text: "I could not read those values, so I changed nothing. Try the form again." };
      const content = upsertArea(draft.content, form);
      return { ...base, text: `Done. I set the ${form.name} area from the form. Check the changes before you publish.`,
        proposal: { content, summary: `Set the ${form.name} area from the form.`, warnings: lintAutonomy(content) } };
    }
    if (/billing/i.test(text)) {
      const content = upsertArea(draft.content, BILLING);
      return { ...base, text: "Billing handles money but not card data, so I made it high risk with C blocking. "
        + "Adjust anything in the form, or ask me to change it.",
        spec: areaFormSpec(BILLING, "Billing sits next to payments. Raise the risk to critical if invoices can move money."),
        proposal: { content, summary: "Add a billing area: high risk, C blocking, lands as a trail ref.", warnings: lintAutonomy(content) } };
    }
    if (/payments|blocking|checkpoint/i.test(text)) {
      const current = readAreaForm(draft.content, "payments");
      const area: AreaForm = { ...BILLING, name: "payments", paths: current?.paths ?? ["src/payments/**"], risk: "critical",
        checkpoints: { A: "blocking", B: "blocking", C: "blocking" } };
      const content = upsertArea(draft.content, area);
      return { ...base, text: "Here is payments with every checkpoint blocking. A person approves each step.",
        spec: checkpointFormSpec("payments", area.checkpoints),
        proposal: { content, summary: "Make A, B and C blocking for payments.", warnings: lintAutonomy(content) } };
    }
    if (/broken|invalid|severe/i.test(text)) {
      const content = `${draft.content.trimEnd()}\n\n## area: labs\npaths: src/labs/**\nrisk: severe\n`;
      return { ...base, text: "I added a labs area, but I am not sure about the risk word. The parser may reject it.",
        proposal: { content, summary: "Add a labs area with risk set to 'severe'.", warnings: lintAutonomy(content) } };
    }
    return { ...base, text: "I can change an area's paths, risk, checkpoints, landing or watch window. Which area, and what should change?" };
  }

  private otherDocReply(draft: Draft, text: string, base: Omit<DraftMessage, "text">): DraftMessage {
    if (draft.kind === "intent") {
      const content = `${draft.content.trimEnd()}\n${text.endsWith(".") ? text : `${text}.`}\n`;
      return { ...base, text: "I added that as a new line at the end of the intent.",
        proposal: { content, summary: "Append your sentence to the intent.", warnings: [] } };
    }
    return { ...base, text: "Thresholds are numbers per backend identity. Tell me which one to move, and by how much." };
  }
}

function makeActivityFor(api: FakeApi) {
  const s = api.snapshot();
  return s.empty ? [] : makeActivity(s.trails, s.now);
}

function parseFormMessage(text: string): AreaForm | null {
  try {
    const json = JSON.parse(text.slice(FORM_PREFIX.length).trim()) as { area?: Partial<AreaForm> };
    const a = json.area;
    if (!a || typeof a.name !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(a.name)) return null;
    return { ...BILLING, ...a, paths: (a.paths ?? BILLING.paths).filter((p) => p.trim()) } as AreaForm;
  } catch {
    return null;
  }
}
