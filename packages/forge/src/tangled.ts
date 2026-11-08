import {
  Unverified, ReconciliationRequired, type OperationLedger, type ForgeAdapter, type ForgeCapabilities,
  type ForgeEvent, type LandingPlan, type LandingReceipt, type LandingMode, type Trail,
} from "@ephyra/core";
import { boundedCommandRunner, type CommandRunner } from "./command";
import { MemoryOperationLedger } from "./ledger";
import { digest, caps, BaseMoved } from "./common";
import { PlainGitAdapter } from "./plain-git";
import { RemoteGitAdapter } from "./remote-git";

type ReadMethod = "com.atproto.repo.getRecord" | "com.atproto.repo.listRecords";
type WriteMethod = "com.atproto.repo.createRecord" | "com.atproto.repo.putRecord" | "org.tangled.review.submitPatch";
export type TangledMethod = ReadMethod | WriteMethod;
export type TangledWriteOptions = {
  repositoryDid: string;
  scope: string;
  /** Service auth must bind aud to repositoryDid and lxm to this exact method, with no ambient identity. */
  authorize: (method?: TangledMethod) => Promise<void>;
  rpc: (method: TangledMethod, input: Record<string, unknown>, operation: { key: string; readOnly: boolean }) => Promise<unknown>;
};
type RecordRef = { uri: string; cid: string };
type RecordValue = Record<string, unknown>;
type ReadRecord = RecordRef & { value: RecordValue };
const TICKET = "org.tangled.track.ticket";
const PATCH = "org.tangled.review.patch";
const fullOid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const object = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Unverified("Tangled record response");
  return value as RecordValue;
};

export class TangledAdapter implements ForgeAdapter {
  readonly name = "tangled";
  private readonly remoteGit: RemoteGitAdapter;
  constructor(
    private readonly repoDir = ".",
    private readonly remote = "knot",
    private readonly run: CommandRunner = boundedCommandRunner(),
    private readonly ledger: OperationLedger = new MemoryOperationLedger(),
    private readonly writes?: TangledWriteOptions,
  ) {
    if (writes && !/^did:plc:[a-z0-9]+$/.test(writes.repositoryDid)) throw new Error("exact Tangled repository DID required");
    this.remoteGit = new RemoteGitAdapter(repoDir, {
      remote, scope: writes?.scope ?? `tangled:${remote}`, ledger, run,
      authorize: async () => { await this.writes?.authorize(); },
    });
  }

  get remoteIdentity(): string { return this.remote; }

  async capabilities(): Promise<ForgeCapabilities> {
    return { ...caps(this.name, this.writes ? ["trail_ref", "tangled_pull"] : ["trail_ref"], true),
      events: Boolean(this.writes), proposals: Boolean(this.writes), customRefs: "unknown" };
  }

  private configured(): TangledWriteOptions {
    if (!this.writes?.scope) throw new Unverified("account-scoped Tangled service authentication");
    return this.writes;
  }

  private ref(value: unknown, collection: string): RecordRef {
    const result = object(value);
    const prefix = `at://${this.configured().repositoryDid}/${collection}/`;
    if (typeof result.uri !== "string" || !result.uri.startsWith(prefix)
      || !/^[a-zA-Z0-9._~:-]{1,512}$/.test(result.uri.slice(prefix.length))
      || typeof result.cid !== "string" || !/^[a-zA-Z0-9]{8,200}$/.test(result.cid)) {
      throw new Unverified("Tangled exact record identity");
    }
    return { uri: result.uri, cid: result.cid };
  }

  private async read(collection: string, rkey: string): Promise<ReadRecord> {
    const options = this.configured();
    await options.authorize("com.atproto.repo.getRecord");
    const raw = object(await options.rpc("com.atproto.repo.getRecord", {
      repo: options.repositoryDid, collection, rkey,
    }, { key: `read:${collection}:${rkey}`, readOnly: true }));
    const ref = this.ref(raw, collection);
    if (ref.uri.split("/").at(-1) !== rkey) throw new Unverified("Tangled record key readback");
    return { ...ref, value: object(raw.value) };
  }

  private async write(method: WriteMethod, input: Record<string, unknown>, key: string, collection: string): Promise<RecordRef> {
    const options = this.configured();
    await options.authorize(method);
    const claim = await this.ledger.begin(key, digest(JSON.stringify([options.scope, options.repositoryDid, method, input])));
    if (!claim.fresh) {
      if (claim.record.status === "done") return claim.record.result as RecordRef;
      throw new ReconciliationRequired(key, "Tangled write requires reconciliation");
    }
    try {
      const result = this.ref(await options.rpc(method, { repo: options.repositoryDid, ...input }, { key, readOnly: false }), collection);
      await this.ledger.complete(key, result);
      return result;
    } catch {
      await this.ledger.markAmbiguous(key, "Tangled write outcome requires reconciliation");
      throw new ReconciliationRequired(key, "Tangled write outcome requires reconciliation");
    }
  }

  /** Rescan bounded snapshots so a changed CID behind an old pagination cursor is not silently skipped. */
  async *events(cursor: string | null): AsyncIterable<ForgeEvent> {
    const options = this.configured();
    const decoded: unknown = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()) : [];
    if (!Array.isArray(decoded) || decoded.length > 5000 || decoded.some(id => typeof id !== "string")) {
      throw new Error("invalid Tangled cursor");
    }
    const seen = new Set<string>(decoded);
    for (const collection of [TICKET, PATCH]) {
      let page: string | undefined;
      for (let count = 0; count < 10; count++) {
        await options.authorize("com.atproto.repo.listRecords");
        const result = object(await options.rpc("com.atproto.repo.listRecords", {
          repo: options.repositoryDid, collection, limit: 100, ...(page ? { cursor: page } : {}),
        }, { key: `events:${collection}:${page ?? "first"}`, readOnly: true }));
        if (!Array.isArray(result.records) || result.records.length > 100) throw new Unverified("Tangled bounded event snapshot");
        for (const raw of result.records) {
          const ref = this.ref(raw, collection);
          const value = object(object(raw).value);
          if (value.$type !== collection) throw new Unverified("Tangled event record type");
          const sourceId = `${ref.uri}:${ref.cid}`;
          if (seen.has(sourceId)) continue;
          if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
            || typeof value["x-tngl-editor"] !== "string") throw new Unverified("Tangled recorded event provenance");
          if (collection === TICKET && typeof value.targetBranch !== "string") continue;
          const commit = collection === PATCH ? object(value.head).oid : undefined;
          if (collection === PATCH && !fullOid(commit)) throw new Unverified("Tangled patch event head");
          seen.add(sourceId);
          if (seen.size > 5000) throw new Unverified("Tangled snapshot cursor capacity");
          yield {
            workspace: options.scope, repo: options.repositoryDid, adapter: this.name, sourceId,
            cursor: Buffer.from(JSON.stringify([...seen].sort())).toString("base64url"), occurredAt: value.createdAt,
            kind: collection === PATCH ? "proposal.updated" : value.state === "open" ? "proposal.opened" : "review.decision",
            objectId: collection === PATCH ? String(value.ticket) : ref.uri, revision: ref.uri,
            ...(typeof commit === "string" ? { commit } : {}), actor: value["x-tngl-editor"] as string,
            payloadDigest: digest(JSON.stringify(value)), body: JSON.stringify(value).slice(0, 8000),
          };
        }
        if (!result.cursor) break;
        if (typeof result.cursor !== "string" || result.cursor === page || count === 9) throw new Unverified("Tangled snapshot pagination");
        page = result.cursor;
      }
    }
  }

  async prepareLanding(trail: Trail, mode: LandingMode, base: string, proof: string): Promise<LandingPlan> {
    if (mode === "trail_ref") return new PlainGitAdapter(this.repoDir, this.run).prepareLanding(trail, mode, base, proof);
    if (mode !== "tangled_pull") throw new Unverified(mode);
    await this.configured().authorize();
    const plan = await new PlainGitAdapter(this.repoDir, this.run).prepareLanding(trail, "auto_land", base, proof);
    return { ...plan, mode };
  }

  async land(plan: LandingPlan, auth: string, key: string): Promise<LandingReceipt> {
    if (plan.mode === "trail_ref") return this.remoteGit.land(plan, auth, key);
    const options = this.configured();
    await options.authorize();
    if (plan.mode !== "tangled_pull" || !auth || !key || !fullOid(plan.expectedBase) || !fullOid(plan.head)
      || !/^refs\/heads\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(plan.target) || plan.target.includes("..")) {
      throw new Error("invalid authorized Tangled pull");
    }
    const claim = await this.ledger.begin(key, digest(JSON.stringify([options.scope, options.repositoryDid, plan, auth])));
    if (!claim.fresh) {
      if (claim.record.status === "done") {
        if ((claim.record.result as { rejected?: string }).rejected === "base_moved") throw new BaseMoved(plan.target);
        return claim.record.result as LandingReceipt;
      }
      throw new ReconciliationRequired(key, "Tangled pull requires reconciliation");
    }
    if (await this.remoteGit.readRemoteRef(plan.target) !== plan.expectedBase) {
      await this.ledger.complete(key, { rejected: "base_moved" });
      throw new BaseMoved(plan.target);
    }
    try {
      const branch = await this.remoteGit.land({ ...plan, mode: "trail_ref" }, auth, `${key}:branch`);
      const now = new Date().toISOString();
      const text = plan.commitMessage?.trim() || `Ephyra repair ${plan.trailId}\n\nEphyra-Proof: ${plan.proofDigest}`;
      const record = { $type: TICKET,
        title: { $type: "org.tangled.markup.markdown#inline", text: text.split("\n")[0]!.slice(0, 300) },
        body: { $type: "org.tangled.markup.markdown", text }, state: "open", targetBranch: plan.target.slice(11), createdAt: now };
      const ticket = await this.write("com.atproto.repo.createRecord", { collection: TICKET, record }, `${key}:ticket`, TICKET);
      const rkey = ticket.uri.split("/").at(-1)!;
      const read = await this.read(TICKET, rkey);
      if (read.cid !== ticket.cid || read.value.targetBranch !== record.targetBranch || read.value.state !== "open") {
        throw new Unverified("Tangled created ticket readback");
      }
      const patch = await this.write("org.tangled.review.submitPatch", {
        patch: { ticket: rkey, base: { oid: plan.expectedBase }, head: { oid: plan.head },
          sourceRepo: options.repositoryDid, sourceBranch: branch.target.slice(11) },
      }, `${key}:patch`, PATCH);
      const revision = await this.read(PATCH, patch.uri.split("/").at(-1)!);
      if (revision.cid !== patch.cid || revision.value.ticket !== rkey
        || object(revision.value.base).oid !== plan.expectedBase || object(revision.value.head).oid !== plan.head) {
        throw new Unverified("Tangled submitted patch readback");
      }
      const receipt: LandingReceipt = { mode: plan.mode, target: plan.target, oldOid: plan.expectedBase, newOid: plan.head,
        proofDigest: plan.proofDigest, authorizationId: auth, externalId: ticket.uri, externalVersion: ticket.cid,
        externalRevision: patch.uri, at: new Date().toISOString() };
      await this.ledger.complete(key, receipt);
      return receipt;
    } catch (error) {
      await this.ledger.markAmbiguous(key, "Tangled pull requires reconciliation; inspect its branch/ticket/patch receipts");
      if (error instanceof BaseMoved) throw error;
      throw new ReconciliationRequired(key, "Tangled pull requires reconciliation; inspect its branch/ticket/patch receipts");
    }
  }

  async revert(receipt: LandingReceipt, key: string): Promise<LandingReceipt> {
    if (receipt.mode === "trail_ref") return this.remoteGit.revert(receipt, key);
    const options = this.configured();
    await options.authorize();
    if (receipt.mode !== "tangled_pull" || !receipt.externalId || !receipt.externalVersion || !key) {
      throw new Unverified("version-bound Tangled pull receipt");
    }
    this.ref({ uri: receipt.externalId, cid: receipt.externalVersion }, TICKET);
    const claim = await this.ledger.begin(key, digest(JSON.stringify([options.scope, "close", receipt])));
    if (!claim.fresh) {
      if (claim.record.status === "done") return claim.record.result as LandingReceipt;
      throw new ReconciliationRequired(key, "Tangled withdrawal requires reconciliation");
    }
    const rkey = receipt.externalId.split("/").at(-1)!;
    const current = await this.read(TICKET, rkey);
    if (current.cid !== receipt.externalVersion) throw new Unverified("Tangled pull changed since its accepted receipt");
    if (current.value.state !== "open") throw new Unverified("merged or closed Tangled pull needs a separately approved canonical rollback");
    const { "x-tngl-editor": _editor, "x-tngl-change": _change, ...record } = current.value;
    const updated = await this.write("com.atproto.repo.putRecord", {
      collection: TICKET, rkey, swapRecord: current.cid, record: { ...record, state: "closed" },
    }, `${key}:ticket`, TICKET);
    const closed = await this.read(TICKET, rkey);
    if (closed.cid !== updated.cid || closed.value.state !== "closed") {
      await this.ledger.markAmbiguous(key, "Tangled withdrawal readback unavailable");
      throw new ReconciliationRequired(key, "Tangled withdrawal readback unavailable");
    }
    const reverted = { ...receipt, externalVersion: updated.cid, at: new Date().toISOString() };
    await this.ledger.complete(key, reverted);
    return reverted;
  }
}
