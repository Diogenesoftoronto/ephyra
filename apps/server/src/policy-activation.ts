import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Draft } from "@ephyra/core";
import { canonicalJson } from "./audit.ts";
import { docKind, hasErrors, inspectDoc, sha256, type PolicyDocs } from "./docs.ts";
import { policyRef } from "./policy-ref.ts";
import type { AuditSink } from "./wiring/human.ts";
import type { Git } from "./wiring/landing.ts";

export const ACTIVE_POLICY_REF = "refs/ephyra/policy/active";
const MANIFEST = ".ephyra-policy-activation.json";
const oid = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({
  principal: z.string().min(1).max(300).regex(/^[^\x00-\x1f\x7f]+$/),
  key: z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/),
  expectedCommit: oid,
  expectedDigest: digest,
  expectedActive: oid.nullable(),
}).strict();
const manifestSchema = z.object({
  schema: z.literal(1), draftId: z.string().regex(/^[0-9a-zA-Z-]{8,64}$/),
  path: z.string(), sourceCommit: oid, sourceDigest: digest,
  principal: z.string().min(1).max(300), at: z.string().datetime(),
  previousActive: oid.nullable(), requestDigest: digest,
  documents: z.array(z.object({ path: z.string(), digest })).max(200),
}).strict();

export type PolicyActivationRequest = z.infer<typeof requestSchema>;
export type PolicyActivationReceipt = z.infer<typeof manifestSchema> & { commit: string };
export class PolicyActivationError extends Error {
  constructor(readonly status: 400 | 409 | 422, message: string) { super(message); }
}

export type PolicyActivationOptions = {
  git: Git;
  docs: PolicyDocs;
  audit: AuditSink;
  now(): Date;
  /** Reloads validated local control-plane policy. It does not deploy application code. */
  apply(documents: Record<string, string>, receipt: PolicyActivationReceipt): Promise<void>;
};

/** Explicit reviewed activation, separate from publication and from application deployment. */
export class PolicyActivation {
  private chain: Promise<unknown> = Promise.resolve();
  private audited = new Set<string>();
  private snapshots = new Map<string, { receipt: PolicyActivationReceipt; documents: Record<string, string> }>();
  constructor(private readonly options: PolicyActivationOptions) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(work);
    this.chain = next;
    return next;
  }

  private async ref(ref: string): Promise<string | null> {
    const rows = await this.options.git(["for-each-ref", "--format=%(refname)%00%(objectname)", ref]);
    const row = rows.split("\n").find((line) => line.split("\0")[0] === ref);
    return row ? oid.parse(row.split("\0")[1]) : null;
  }

  private async snapshot(commit: string): Promise<{ receipt: PolicyActivationReceipt; documents: Record<string, string> }> {
    const cached = this.snapshots.get(commit);
    if (cached) return structuredClone(cached);
    const raw = await this.options.git(["show", `${commit}:${MANIFEST}`]);
    if (Buffer.byteLength(raw) > 100_000) throw new PolicyActivationError(422, "The active policy manifest exceeds its limit.");
    const state = manifestSchema.parse(JSON.parse(raw));
    const documents: Record<string, string> = {};
    for (const entry of state.documents) {
      const kind = docKind(entry.path);
      if (!kind || Object.hasOwn(documents, entry.path)) throw new PolicyActivationError(422, "The active policy contains an invalid document.");
      const content = await this.options.git(["show", `${commit}:${entry.path}`]);
      if (sha256(content) !== entry.digest || hasErrors(inspectDoc(kind, content)))
        throw new PolicyActivationError(422, "The active policy document cannot be validated.");
      documents[entry.path] = content;
    }
    if (!Object.hasOwn(documents, state.path) || sha256(documents[state.path]!) !== state.sourceDigest)
      throw new PolicyActivationError(422, "The active policy source binding is invalid.");
    const snapshot = { receipt: { ...state, commit }, documents };
    if (this.snapshots.size >= 4) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(commit, structuredClone(snapshot));
    return snapshot;
  }

  async current(): Promise<PolicyActivationReceipt | null> {
    const commit = await this.ref(ACTIVE_POLICY_REF);
    return commit ? (await this.snapshot(commit)).receipt : null;
  }

  async content(path: string): Promise<string | null> {
    if (!docKind(path)) return null;
    const commit = await this.ref(ACTIVE_POLICY_REF);
    return commit ? (await this.snapshot(commit)).documents[path] ?? null : null;
  }

  async paths(): Promise<string[]> {
    const commit = await this.ref(ACTIVE_POLICY_REF);
    return commit ? Object.keys((await this.snapshot(commit)).documents) : [];
  }

  private async audit(receipt: PolicyActivationReceipt): Promise<void> {
    if (this.audited.has(receipt.commit)) return;
    try {
      await this.options.audit.append({
        id: `policy.activate:${receipt.commit}`, at: receipt.at, principal: receipt.principal,
        action: "policy.activate", target: receipt.draftId,
        detail: { path: receipt.path, sourceCommit: receipt.sourceCommit, digest: receipt.sourceDigest,
          activeCommit: receipt.commit, previousActive: receipt.previousActive },
      });
    } catch (error) {
      // Production audit deduplicates this immutable commit-derived ID after a restart.
      if (!String(error).includes("audit id reused")) throw error;
    }
    this.audited.add(receipt.commit);
  }

  private async reload(): Promise<PolicyActivationReceipt | null> {
    const commit = await this.ref(ACTIVE_POLICY_REF);
    if (!commit) return null;
    const { receipt, documents } = await this.snapshot(commit);
    await this.audit(receipt);
    await this.options.apply(documents, receipt);
    return receipt;
  }

  /** Replays the durable current state after a restart or an interrupted local reload. */
  restore(): Promise<PolicyActivationReceipt | null> { return this.serial(() => this.reload()); }

  activate(draft: Draft, input: PolicyActivationRequest): Promise<PolicyActivationReceipt> {
    return this.serial(async () => {
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) throw new PolicyActivationError(400, "Invalid policy activation request.");
      const request = parsed.data;
      if (draft.status !== "published" || !draft.published || draft.published.ref !== policyRef(draft.id))
        throw new PolicyActivationError(409, "Publish and review the draft before activating it.");
      const requestDigest = sha256(canonicalJson({ ...request, draftId: draft.id, path: draft.path }));
      const operationRef = `refs/ephyra/policy/activation-operations/${sha256(request.key)}`;
      const previousOperation = await this.ref(operationRef);
      if (previousOperation) {
        const { receipt } = await this.snapshot(previousOperation);
        if (receipt.requestDigest !== requestDigest) throw new PolicyActivationError(409, "The activation key was used for another request.");
        // Never replay an old policy over a later activation. Reload only the current durable snapshot.
        await this.audit(receipt);
        await this.reload();
        return receipt;
      }
      const current = await this.ref(ACTIVE_POLICY_REF);
      if (request.expectedActive !== current) throw new PolicyActivationError(409, "The active policy changed. Review the current version.");
      if (draft.published.commit !== request.expectedCommit || await this.ref(draft.published.ref) !== request.expectedCommit)
        throw new PolicyActivationError(409, "The published policy commit changed.");
      const kind = docKind(draft.path);
      const content = await this.options.git(["show", `${request.expectedCommit}:${draft.path}`]);
      if (!kind || content !== draft.content || sha256(content) !== request.expectedDigest)
        throw new PolicyActivationError(409, "The reviewed policy content changed.");
      const documents = Object.fromEntries((await this.options.docs.list()).map((doc) => [doc.path, doc.content]));
      if (current) Object.assign(documents, (await this.snapshot(current)).documents);
      if (sha256(documents[draft.path] ?? "") !== draft.baseDigest)
        throw new PolicyActivationError(409, "The effective document changed since this draft was started.");
      documents[draft.path] = content;
      if (Object.keys(documents).length > 200) throw new PolicyActivationError(422, "The active policy has too many documents.");
      for (const [path, text] of Object.entries(documents)) {
        const doc = docKind(path);
        if (!doc || hasErrors(inspectDoc(doc, text))) throw new PolicyActivationError(422, "Fix policy validation errors before activation.");
      }
      const state: z.infer<typeof manifestSchema> = {
        schema: 1, draftId: draft.id, path: draft.path, sourceCommit: request.expectedCommit, sourceDigest: request.expectedDigest,
        principal: request.principal, at: this.options.now().toISOString(), previousActive: current, requestDigest,
        documents: Object.entries(documents).sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => ({ path, digest: sha256(text) })),
      };
      const directory = await mkdtemp(join(tmpdir(), "ephyra-activation-"));
      try {
        const env = { GIT_INDEX_FILE: join(directory, "index") };
        await this.options.git(["read-tree", "--empty"], { env });
        for (const [path, text] of [...Object.entries(documents), [MANIFEST, JSON.stringify(state)]]) {
          const blob = (await this.options.git(["hash-object", "-w", "--stdin"], { input: text })).trim();
          await this.options.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
        }
        const tree = (await this.options.git(["write-tree"], { env })).trim();
        const commit = (await this.options.git(["commit-tree", tree, ...(current ? ["-p", current] : [])], {
          input: `policy: activate ${draft.path}\n\nEphyra-Draft: ${draft.id}\nEphyra-Approver: ${request.principal}\n`,
          env: { GIT_AUTHOR_NAME: "Ephyra", GIT_AUTHOR_EMAIL: "policy@ephyra.invalid", GIT_COMMITTER_NAME: "Ephyra",
            GIT_COMMITTER_EMAIL: "policy@ephyra.invalid", GIT_AUTHOR_DATE: state.at, GIT_COMMITTER_DATE: state.at },
        })).trim();
        // The operation receipt and active pointer either both advance or neither does, across processes too.
        try {
          await this.options.git(["update-ref", "--stdin"], { input: ["start", `verify ${draft.published.ref} ${request.expectedCommit}`,
            `create ${operationRef} ${commit}`, current ? `update ${ACTIVE_POLICY_REF} ${commit} ${current}` : `create ${ACTIVE_POLICY_REF} ${commit}`,
            "prepare", "commit", ""].join("\n") });
        } catch {
          const winner = await this.ref(operationRef);
          if (winner && (await this.snapshot(winner)).receipt.requestDigest === requestDigest) {
            await this.reload();
            return (await this.snapshot(winner)).receipt;
          }
          throw new PolicyActivationError(409, "Another policy activation changed the reviewed state.");
        }
        const receipt = { ...state, commit };
        await this.audit(receipt);
        await this.reload();
        return receipt;
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
}
