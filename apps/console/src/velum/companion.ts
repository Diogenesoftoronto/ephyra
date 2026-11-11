// The workspace Velum conversation, independent of React. One instance belongs to one account+workspace scope; a scope
// change creates a new instance, and every asynchronous result carries the generation that started it, so a late reply
// can never land in another scope. Text and voice turns share this one conversation.
import {
  addReference, referenceKey, VELUM_MAX_REFERENCES, type VelumReference, type VelumResolvedReference, type VoiceContext,
  type VoiceReceipt, type VoiceReply,
} from "@ephyra/core";
import { ApiError, UnknownWriteOutcome, VoiceRequestError, type ConsoleApi } from "../api.ts";

export type Chip = {
  key: string;
  ref: VelumReference;
  /** The label the person saw, from the page's own data. Display only; the server reads the record itself. */
  label: string;
  /** The page region it came from, when it is still on screen. */
  sourceId: string | null;
  /** Where the source lives in the console, to return to it from another page. */
  href: string | null;
  selectedAt: number;
  status: "current" | "changed" | "missing";
  /** A newer revision the page or server reported, when changed. */
  latest?: { ref: VelumReference; label: string } | null;
};

export type TurnStatus = "sent" | "unconfirmed" | "rate-limited" | "refused" | "unavailable" | "failed";
export type Turn =
  | { id: string; role: "user"; text: string; chips: Chip[]; via: "typed" | "spoken"; asked: string; status: TurnStatus;
      operationKey: string; context: VoiceContext; error?: string; retryAfterSeconds?: number }
  | { id: string; role: "assistant"; text: string; replyTo: string; engine: string | null; costMicrousd: number | null;
      references: VelumResolvedReference[] };

export type CompanionState = {
  turns: Turn[];
  chips: Chip[];
  sending: string | null;
  /** A notice that is not a message: e.g. a chip was dropped because the list is full. */
  notice: string | null;
  receipts: VoiceReceipt[];
  /** Unsent composer text, kept across close/reopen and page changes within this scope. */
  draft: string;
};

const EMPTY: CompanionState = { turns: [], chips: [], sending: null, notice: null, receipts: [], draft: "" };
let counter = 0;
const id = (p: string) => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export type SendOutcome =
  | { kind: "sent" }
  /** The request did not run (refused/rate-limited/unavailable). The text belongs back in the composer. */
  | { kind: "kept"; text: string }
  /** Unknown outcome: the text stays on its own unconfirmed message. */
  | { kind: "unconfirmed" }
  /** The scope changed or the companion was disposed; nothing is shown. */
  | { kind: "discarded" };

export class VelumCompanion {
  private state: CompanionState = EMPTY;
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort = new AbortController();
  private disposed = false;
  constructor(
    readonly scope: string,
    private readonly api: Pick<ConsoleApi, "voiceReply">,
    private readonly opKey: () => string = () => `velum-${crypto.randomUUID()}`,
    private readonly now: () => number = () => Date.now(),
  ) {}
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  };
  getSnapshot = () => this.state;
  private set(patch: Partial<CompanionState>) {
    this.state = { ...this.state, ...patch };
    for (const f of this.listeners) f();
  }
  /** React may replay an effect's setup after cleanup. Reactivate without reviving the previous request generation. */
  activate() {
    if (!this.disposed) return;
    this.disposed = false;
    this.abort = new AbortController();
  }
  /** Stop listening for in-flight results. Called on scope change and unmount. */
  dispose() {
    this.disposed = true;
    this.generation++;
    this.abort.abort();
    this.listeners.clear();
  }

  // ── references ──
  add(ref: VelumReference, label: string, sourceId: string | null, href: string | null = null) {
    const result = addReference(this.state.chips, { key: referenceKey(ref), ref, label, sourceId, href, selectedAt: this.now(), status: "current" as const });
    this.set({
      chips: result.list,
      notice: result.dropped ? `Velum can look at ${VELUM_MAX_REFERENCES} things at once. Remove one to add ${label}.` : null,
    });
    return !result.dropped;
  }
  toggle(ref: VelumReference, label: string, sourceId: string | null, href: string | null = null) {
    const key = referenceKey(ref);
    if (this.state.chips.some((c) => c.key === key)) this.remove(key);
    else this.add(ref, label, sourceId, href);
  }
  setDraft(draft: string) {
    if (draft !== this.state.draft) this.set({ draft });
  }
  remove(key: string) {
    this.set({ chips: this.state.chips.filter((c) => c.key !== key), notice: null });
  }
  clear() {
    this.set({ chips: [], notice: null });
  }
  /** The page reports what each on-screen source looks like now. A different key for the same source marks it changed. */
  reconcile(sources: ReadonlyMap<string, { ref: VelumReference; label: string }>) {
    let touched = false;
    const chips = this.state.chips.map((chip) => {
      const now = chip.sourceId ? sources.get(chip.sourceId) : undefined;
      if (!now) return chip;
      const key = referenceKey(now.ref);
      if (key === chip.key || (chip.latest && referenceKey(chip.latest.ref) === key)) return chip;
      touched = true;
      return { ...chip, status: "changed" as const, latest: now };
    });
    if (touched) this.set({ chips });
  }
  /** Replace a changed chip with its latest revision, keeping its place. */
  refresh(key: string) {
    const chip = this.state.chips.find((c) => c.key === key);
    if (!chip?.latest) return;
    const next: Chip = { key: referenceKey(chip.latest.ref), ref: chip.latest.ref, label: chip.latest.label, sourceId: chip.sourceId,
      href: chip.href, selectedAt: this.now(), status: "current", latest: null };
    this.set({ chips: this.state.chips.map((c) => (c.key === key ? next : c)).filter((c, i, all) => all.findIndex((x) => x.key === c.key) === i) });
  }

  // ── conversation ──
  /** Sending is held while an earlier turn's outcome is unknown, so the same words are not paid for twice by accident. */
  get blocked(): Turn | null {
    return this.state.turns.find((t) => t.role === "user" && t.status === "unconfirmed") ?? null;
  }
  async send(text: string, context: VoiceContext, asked: string, via: "typed" | "spoken" = "typed"): Promise<SendOutcome> {
    if (this.disposed) return { kind: "discarded" };
    if (text.length > 6000) { this.set({ notice: "Messages can be up to 6,000 characters. Shorten it and send again." }); return { kind: "kept", text }; }
    const trimmed = text.trim();
    if (!trimmed || this.state.sending || this.blocked) return { kind: "kept", text };
    const stale = this.state.chips.filter((c) => c.status !== "current");
    if (stale.length) {
      this.set({ notice: `${stale.map((c) => c.label).join(", ")} changed. Refresh or remove ${stale.length === 1 ? "it" : "them"} before sending.` });
      return { kind: "kept", text };
    }
    const chips = this.state.chips;
    const turn: Turn = { id: id("u"), role: "user", text: trimmed, chips, via, asked, status: "sent", operationKey: this.opKey(), context };
    this.set({ turns: [...this.state.turns, turn], sending: turn.id, notice: null, draft: "" });
    return this.dispatch(turn, context);
  }
  /**
   * Ask the server about an unconfirmed turn with the SAME operation key. The server replays a finished reply, answers
   * that it is still unresolved, or reports the stored error; it never runs the model a second time for that key.
   */
  async checkSaved(turnId: string): Promise<SendOutcome> {
    if (this.disposed) return { kind: "discarded" };
    const turn = this.state.turns.find((t) => t.id === turnId);
    if (!turn || turn.role !== "user" || turn.status !== "unconfirmed" || this.state.sending) return { kind: "discarded" };
    this.set({ sending: turn.id, notice: null });
    // Same key, same context, same references and same history: the server can only replay or report, never re-run.
    return this.dispatch(turn, turn.context);
  }
  /** The person decides to leave an unconfirmed turn unresolved and continue. It stays visible and is not resent. */
  setAside(turnId: string) {
    this.patchTurn(turnId, { status: "failed", error: "Left unresolved by you. It may still have finished and been billed; Usage shows the record." });
  }
  /** Stop waiting. A request already sent may still finish; the turn is marked unconfirmed, never silently dropped. */
  stop() {
    const sending = this.state.sending;
    if (!sending) return;
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.patchTurn(sending, { status: "unconfirmed", error: "You stopped waiting. The request was already sent and may still finish and be billed." });
    this.set({ sending: null });
  }
  private patchTurn(turnId: string, patch: Partial<Extract<Turn, { role: "user" }>>) {
    this.set({ turns: this.state.turns.map((t) => (t.id === turnId && t.role === "user" ? { ...t, ...patch } : t)) });
  }
  private async dispatch(turn: Extract<Turn, { role: "user" }>, context: VoiceContext): Promise<SendOutcome> {
    const g = ++this.generation;
    const history = this.state.turns
      .filter((t) => t.role === "assistant" || t.status === "sent" || t.id === turn.id)
      .slice(-20)
      .map((t) => ({ role: t.role, text: t.text }));
    let reply: VoiceReply;
    try {
      reply = await this.api.voiceReply({ context, messages: history, ...(turn.chips.length ? { references: turn.chips.map((c) => c.ref) } : {}) },
        turn.operationKey, this.abort.signal);
    } catch (error) {
      if (g !== this.generation) return { kind: "discarded" };
      return this.failed(turn, error);
    }
    if (g !== this.generation) return { kind: "discarded" };
    const answer: Turn = { id: id("a"), role: "assistant", text: reply.text, replyTo: turn.id, engine: reply.receipt.engine,
      costMicrousd: reply.receipt.costMicrousd, references: reply.references ?? [] };
    this.patchTurn(turn.id, { status: "sent", error: undefined });
    this.set({
      turns: [...this.state.turns.filter((t) => !(t.role === "assistant" && t.replyTo === turn.id)), answer],
      sending: null,
      receipts: this.state.receipts.some((r) => r.operationKey === reply.receipt.operationKey) ? this.state.receipts : [...this.state.receipts, reply.receipt],
      // Chips stay attached to the conversation so a follow-up can refer to the same things; the person clears them.
    });
    return { kind: "sent" };
  }
  private failed(turn: Extract<Turn, { role: "user" }>, error: unknown): SendOutcome {
    const code = error instanceof VoiceRequestError ? error.code : null;
    const message = error instanceof Error ? error.message : "Velum could not answer.";
    if (code === "reference_changed" && error instanceof VoiceRequestError) {
      const resolved = new Map((error.references ?? []).map((r) => [r.key, r]));
      this.set({
        chips: this.state.chips.map((c) => {
          const r = resolved.get(c.key);
          return r && r.status !== "current" ? { ...c, status: r.status } : c;
        }),
      });
      return this.drop(turn, message);
    }
    if (code === "rate_limited" || (error instanceof ApiError && error.status === 429)) {
      const retry = error instanceof VoiceRequestError ? error.retryAfterSeconds : error instanceof ApiError ? error.retryAfterSeconds : undefined;
      this.patchTurn(turn.id, { status: "rate-limited", error: retry !== undefined
        ? `Velum's provider asked to wait ${retry} seconds. Nothing ran; your words are back in the message box.`
        : "Velum's provider is busy and did not say for how long. Nothing ran; your words are back in the message box.",
        ...(retry !== undefined ? { retryAfterSeconds: retry } : {}) });
      this.set({ sending: null, draft: this.state.draft || turn.text });
      return { kind: "kept", text: turn.text };
    }
    if (code === "reconciliation_required" || error instanceof UnknownWriteOutcome) {
      this.patchTurn(turn.id, { status: "unconfirmed", error: message });
      this.set({ sending: null });
      return { kind: "unconfirmed" };
    }
    if (error instanceof DOMException && error.name === "AbortError") return { kind: "discarded" };
    const unavailable = code === "unavailable" || code === "demo" || code === "voice_unavailable" || code === "references_unavailable";
    this.patchTurn(turn.id, { status: unavailable ? "unavailable" : "failed", error: message });
    this.set({ sending: null, draft: this.state.draft || turn.text });
    return { kind: "kept", text: turn.text };
  }
  /** A refused turn never ran: remove it and give the words back. */
  private drop(turn: Extract<Turn, { role: "user" }>, message: string): SendOutcome {
    this.set({ turns: this.state.turns.filter((t) => t.id !== turn.id), sending: null, notice: message, draft: this.state.draft || turn.text });
    return { kind: "kept", text: turn.text };
  }
}
