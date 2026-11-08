// Policy drafts: storage (memory + Convex) and the service behind /v1/drafts.
// Publishing writes a commit to refs/ephyra/policy/<draft-id> and an audit entry. It never edits the live policy.
import { Draft, type AreaSketch, type DraftMessage } from "@ephyra/core";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { docKind, hasErrors, inspectDoc, renderSketches, sha256, sketchesFor, MAX_DOC_BYTES, type PolicyDocs } from "./docs.ts";
import { PolicyRefConflict, writePolicyRef } from "./policy-ref.ts";
import type { Velum, Quote } from "./velum.ts";
import type { AuditSink } from "./wiring/human.ts";
import type { Git } from "./wiring/landing.ts";
import type { PolicyActivation, PolicyActivationRequest, PolicyActivationReceipt } from "./policy-activation.ts";

export interface DraftStore {
  get(id: string): Promise<Draft | null>;
  put(draft: Draft): Promise<void>;
  /** Newest first. */
  list(status?: Draft["status"]): Promise<Draft[]>;
}

export class MemoryDraftStore implements DraftStore {
  private drafts = new Map<string, Draft>();
  async get(id: string) { const d = this.drafts.get(id); return d ? Draft.parse(structuredClone(d)) : null; }
  async put(draft: Draft) { this.drafts.set(draft.id, Draft.parse(structuredClone(draft))); }
  async list(status?: Draft["status"]) {
    return [...this.drafts.values()].filter((d) => !status || d.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((d) => Draft.parse(structuredClone(d)));
  }
}

export class ConvexDraftStore implements DraftStore {
  constructor(private readonly client: ConvexHttpClient, private readonly secret: string) {}
  async get(id: string) {
    const json = await this.client.query(api.drafts.get, { secret: this.secret, draftId: id });
    return json ? Draft.parse(JSON.parse(json)) : null;
  }
  async put(draft: Draft) {
    const valid = Draft.parse(draft);
    await this.client.mutation(api.drafts.put, { secret: this.secret, draftId: valid.id, json: JSON.stringify(valid) });
  }
  async list(status?: Draft["status"]) {
    const rows = await this.client.query(api.drafts.list, { secret: this.secret, ...(status ? { status } : {}) });
    return rows.map((json) => Draft.parse(JSON.parse(json)));
  }
}

/** An error the HTTP layer turns into a response with this status. */
export class DraftError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422, message: string) { super(message); }
}

export type DraftDeps = {
  store: DraftStore; docs: PolicyDocs; velum: Velum; git: Git; audit: AuditSink; baseRef: string;
  now: () => Date; id: () => string; log: (msg: string, fields?: Record<string, unknown>) => void;
  activation?: PolicyActivation;
};

const MAX_TEXT = 8000;
const KEY = /^[A-Za-z0-9._:-]{8,100}$/;

export class DraftService {
  private chains = new Map<string, Promise<unknown>>();
  constructor(private readonly d: DraftDeps) {}

  /** One writer per draft at a time (the store has no compare-and-swap of its own). */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.chains.set(id, next);
    void next.catch(() => undefined).finally(() => { if (this.chains.get(id) === next) this.chains.delete(id); });
    return next;
  }

  private async load(id: string): Promise<Draft> {
    const draft = await this.d.store.get(id);
    if (!draft) throw new DraftError(404, "draft not found");
    return draft;
  }
  private open(draft: Draft): void {
    if (draft.status !== "open") throw new DraftError(409, `draft is ${draft.status}`);
  }
  private save(draft: Draft): Promise<Draft> {
    const next = { ...draft, updatedAt: this.d.now().toISOString() };
    return this.d.store.put(next).then(() => next);
  }

  /** The draft as the API returns it: the core shape plus the application map of its current text (autonomy drafts that parse). */
  view(draft: Draft): Draft & { sketches?: AreaSketch[] } {
    const sketches = sketchesFor(draft.kind, draft.content);
    return sketches ? { ...draft, sketches } : draft;
  }

  get(id: string) { return this.load(id); }
  list(status?: Draft["status"]) { return this.d.store.list(status); }

  /** A separate approver action; publication alone never changes the running policy. */
  async activate(id: string, input: PolicyActivationRequest): Promise<PolicyActivationReceipt> {
    if (!this.d.activation) throw new DraftError(422, "Policy activation is not configured.");
    return this.d.activation.activate(await this.load(id), input);
  }

  async create(path: string, principal: string): Promise<Draft> {
    const kind = docKind(path);
    if (!kind) throw new DraftError(400, "path is not an editable policy document");
    const doc = await this.d.docs.get(path);
    // A new intent starts from an empty document; autonomy and thresholds always exist (template at worst).
    if (!doc && kind !== "intent") throw new DraftError(404, "document not found");
    const content = doc?.content ?? "";
    const at = this.d.now().toISOString();
    const draft: Draft = {
      id: this.d.id(), path, kind, baseDigest: doc?.digest ?? sha256(""), content, warnings: doc?.warnings ?? inspectDoc(kind, content),
      status: "open", createdBy: principal, createdAt: at, updatedAt: at, messages: [],
    };
    await this.d.store.put(draft);
    return draft;
  }

  /**
   * Appends the human message and Velum's reply. A client-supplied Idempotency-Key becomes the human message id, so a retried
   * request returns the draft as it already is instead of asking (and paying) the model twice.
   */
  message(id: string, input: { text: string; quotes?: Quote[]; principal: string; key?: string }): Promise<Draft> {
    const text = input.text.trim();
    if (!text || text.length > MAX_TEXT) throw new DraftError(400, `text must be 1 to ${MAX_TEXT} characters`);
    if (input.key !== undefined && !KEY.test(input.key)) throw new DraftError(400, "invalid Idempotency-Key");
    return this.serial(id, async () => {
      const draft = await this.load(id);
      this.open(draft);
      const humanId = input.key ?? this.d.id();
      if (draft.messages.some((m) => m.id === humanId)) return draft;
      const human: DraftMessage = { id: humanId, at: this.d.now().toISOString(), role: "human", author: input.principal, text };
      const replies = await this.d.velum.reply(draft, text, input.quotes ?? [], humanId);
      return this.save({ ...draft, messages: [...draft.messages, human, ...replies] });
    });
  }

  setContent(id: string, input: { content: string; baseDigest: string }): Promise<Draft> {
    if (Buffer.byteLength(input.content) > MAX_DOC_BYTES) throw new DraftError(400, "document is too large");
    return this.serial(id, async () => {
      const draft = await this.load(id);
      this.open(draft);
      if (input.baseDigest !== draft.baseDigest) throw new DraftError(409, "this draft is based on a different version of the document");
      return this.save({ ...draft, content: input.content, warnings: inspectDoc(draft.kind, input.content) });
    });
  }

  /** Edit the application map: the sketches are the complete set of mapped areas, rendered through sketchToArea → renderAutonomy. */
  setSketches(id: string, input: { sketches: AreaSketch[]; baseDigest: string }): Promise<Draft> {
    return this.serial(id, async () => {
      const draft = await this.load(id);
      this.open(draft);
      if (draft.kind !== "autonomy") throw new DraftError(400, "the application map only applies to the autonomy document");
      if (input.baseDigest !== draft.baseDigest) throw new DraftError(409, "this draft is based on a different version of the document");
      if (hasErrors(inspectDoc("autonomy", draft.content))) throw new DraftError(409, "the draft text has errors; fix it before editing the map");
      const rendered = renderSketches("autonomy", draft.content, input.sketches);
      if ("error" in rendered) throw new DraftError(400, rendered.error);
      // Notes are warnings (they never block publishing); parse errors in the result would, so they come from the parser, not from us.
      return this.save({ ...draft, content: rendered.content, warnings: [...inspectDoc("autonomy", rendered.content), ...rendered.notes] });
    });
  }

  apply(id: string, messageId: string): Promise<Draft> {
    return this.serial(id, async () => {
      const draft = await this.load(id);
      this.open(draft);
      const proposal = draft.messages.find((m) => m.id === messageId)?.proposal;
      if (!proposal) throw new DraftError(404, "that message has no proposal");
      // Re-parse: the stored warnings describe what the model proposed when it replied, not what we trust now.
      return this.save({ ...draft, content: proposal.content, warnings: inspectDoc(draft.kind, proposal.content) });
    });
  }

  discard(id: string): Promise<Draft> {
    return this.serial(id, async () => {
      const draft = await this.load(id);
      if (draft.status === "discarded") return draft;
      this.open(draft);
      return this.save({ ...draft, status: "discarded" });
    });
  }

  publish(id: string, approver: string): Promise<Draft> {
    return this.serial(id, async () => {
      const draft = await this.load(id);
      this.open(draft);
      const warnings = inspectDoc(draft.kind, draft.content);
      if (hasErrors(warnings)) throw new DraftError(409, "the draft has errors and cannot be published");
      const current = await this.d.docs.get(draft.path);
      if ((current?.digest ?? sha256("")) !== draft.baseDigest) {
        throw new DraftError(409, "the document changed since this draft was started; start a new draft from the current version");
      }
      let written: { ref: string; commit: string };
      try {
        written = await writePolicyRef(this.d.git, {
          draftId: draft.id, path: draft.path, content: draft.content, approver, baseRef: this.d.baseRef, at: this.d.now(),
        });
      } catch (error) {
        if (error instanceof PolicyRefConflict) throw new DraftError(409, error.message);
        throw error;
      }
      const at = this.d.now().toISOString();
      // The audit id is fixed per draft so a replay after a crash cannot add a second entry.
      try {
        await this.d.audit.append({
          id: `policy.publish:${draft.id}`, at, principal: approver, action: "policy.publish", target: draft.id,
          detail: { path: draft.path, ref: written.ref, commit: written.commit, baseDigest: draft.baseDigest, digest: sha256(draft.content) },
        });
      } catch (error) {
        if (!String(error).includes("audit id reused")) throw error;
      }
      return this.save({ ...draft, warnings, status: "published", published: { ...written, by: approver, at } });
    });
  }
}
