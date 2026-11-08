import {
  Unverified,
  ReconciliationRequired,
  type ForgeAdapter,
  type ForgeCapabilities,
  type ForgeEvent,
  type LandingPlan,
  type LandingReceipt,
  type LandingMode,
  type Trail,
  type OperationLedger,
} from "@ephyra/core";
import { caps, digest } from "./common";
import { boundedCommandRunner, type CommandRunner } from "./command";
import { PlainGitAdapter } from "./plain-git";

export type RadicleWriteOptions = {
  /** The caller supplies a scoped signing profile through its injected command runner. */
  scope: string;
  ledger: OperationLedger;
  authorize: () => Promise<void>;
  remote?: string;
};
export class RadicleAdapter implements ForgeAdapter {
  readonly name = "radicle";
  constructor(
    private readonly repoDir = ".",
    private readonly repository = "",
    private readonly run: CommandRunner = boundedCommandRunner(),
    private readonly workspace = "default",
    private readonly writes?: RadicleWriteOptions,
  ) {}
  async capabilities(): Promise<ForgeCapabilities> {
    return { ...caps(this.name, ["radicle_patch"], Boolean(this.writes)), proposals: true, conditionalWrites: false, customRefs: "unknown" };
  }
  async *events(cursor: string | null): AsyncIterable<ForgeEvent> {
    if (!this.repository)
      throw new Unverified("Radicle repository id required");
    let seen: string[];
    try {
      seen = cursor
        ? JSON.parse(Buffer.from(cursor, "base64url").toString())
        : [];
      if (!Array.isArray(seen) || seen.some((id) => typeof id !== "string"))
        throw new Error();
    } catch {
      throw new Error("invalid Radicle cursor");
    }
    const list = await this.run(
      [
        "rad",
        "cob",
        "list",
        "--repo",
        this.repository,
        "--type",
        "xyz.radicle.patch",
      ],
      this.repoDir,
    );
    if (list.code) throw new Unverified("Radicle COB list unavailable");
    const ids = list.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.some((id) => !/^[a-f0-9]{40}$/.test(id)))
      throw new Unverified("unknown Radicle COB list format");
    const emitted = new Set(seen);
    for (const id of ids.sort()) {
      const result = await this.run(
        [
          "rad",
          "cob",
          "show",
          "--repo",
          this.repository,
          "--type",
          "xyz.radicle.patch",
          "--object",
          id,
        ],
        this.repoDir,
      );
      if (result.code) throw new Unverified("Radicle COB show unavailable");
      for (const event of parseRadicleCob(
        id,
        result.stdout,
        this.workspace,
        this.repository,
      )) {
        if (emitted.has(event.sourceId)) continue;
        emitted.add(event.sourceId);
        event.cursor = Buffer.from(
          JSON.stringify([...emitted].sort()),
        ).toString("base64url");
        yield event;
      }
    }
  }
  async prepareLanding(
    trail: Trail,
    mode: LandingMode,
    base: string,
    proof: string,
  ): Promise<LandingPlan> {
    await this.authorized();
    if (mode !== "radicle_patch") throw new Unverified(mode);
    const local = await new PlainGitAdapter(this.repoDir, this.run).prepareLanding(trail, "auto_land", base, proof);
    const patch = trail.mirrors.radicleCob;
    if (patch && !/^[a-f0-9]{40}$/.test(patch)) throw new Error("full Radicle patch identity required");
    return { ...local, mode, target: patch ? `refs/heads/patches/${patch}` : "refs/patches" };
  }

  private async authorized(): Promise<RadicleWriteOptions> {
    if (!this.writes || !this.repository || !this.writes.scope) throw new Unverified("account-scoped Radicle signing transport");
    await this.writes.authorize();
    return this.writes;
  }

  private async snapshot(patch: string): Promise<Record<string, unknown>> {
    const result = await this.run([
      "rad", "cob", "show", "--repo", this.repository, "--type", "xyz.radicle.patch", "--object", patch,
    ], this.repoDir);
    if (result.code) throw new Unverified("Radicle patch receipt readback");
    try {
      const snapshot: unknown = JSON.parse(result.stdout);
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error();
      return snapshot as Record<string, unknown>;
    } catch { throw new Unverified("Radicle patch receipt readback"); }
  }
  // Patch push and CI event reference: https://radicle-ci-broker.liw.fi/userguide.html
  async land(
    plan: LandingPlan,
    auth: string,
    key: string,
  ): Promise<LandingReceipt> {
    const writes = await this.authorized();
    if (plan.mode !== "radicle_patch" || !auth || !key || !/^[a-f0-9]{40}$/.test(plan.head)
      || !/^[a-f0-9]{40}$/.test(plan.expectedBase)) throw new Error("invalid authorized Radicle patch");
    const existing = /^refs\/heads\/patches\/([a-f0-9]{40})$/.exec(plan.target)?.[1];
    if (!existing && plan.target !== "refs/patches") throw new Error("invalid Radicle patch target");
    const claim = await writes.ledger.begin(key, digest(JSON.stringify([writes.scope, this.repository, plan, auth])));
    if (!claim.fresh) {
      if (claim.record.status === "done") return claim.record.result as LandingReceipt;
      throw new ReconciliationRequired(key, "Radicle patch push requires reconciliation");
    }
    const remote = writes.remote ?? "rad";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) throw new Error("invalid scoped Radicle remote");
    try {
      const result = await this.run([
        "git", "push", remote, `${plan.head}:${plan.target}`, "-o", `patch.message=${plan.commitMessage ?? "Ephyra repair"}`,
        "-o", `patch.base=${plan.expectedBase}`,
      ], this.repoDir);
      if (result.code) throw new Error("Radicle push outcome unavailable");
      const response = parseRadiclePush(result.stdout + result.stderr);
      const patch = existing ?? response.patchId;
      if (!/^[a-f0-9]{40}$/.test(patch)) throw new Unverified("full Radicle patch identity");
      if (existing && !existing.startsWith(response.patchId)) throw new Unverified("Radicle updated patch identity");
      const snapshot = await this.snapshot(patch);
      const events = parseRadicleCob(patch, JSON.stringify(snapshot), this.workspace, this.repository);
      const revisions = snapshot.revisions as Record<string, { oid?: string; base?: string }> | undefined;
      const latest = Array.isArray(snapshot.timeline) ? snapshot.timeline.at(-1) as string | undefined : undefined;
      if (!events.some(event => event.commit === plan.head) || !latest || revisions?.[latest]?.oid !== plan.head
        || revisions[latest]?.base !== plan.expectedBase) throw new Unverified("Radicle proposed head readback");
      const receipt: LandingReceipt = { mode: plan.mode, target: patch, oldOid: plan.expectedBase, newOid: plan.head,
        authorizationId: auth, proofDigest: plan.proofDigest, externalId: patch, at: new Date().toISOString() };
      await writes.ledger.complete(key, receipt);
      return receipt;
    } catch {
      await writes.ledger.markAmbiguous(key, "Radicle patch push outcome requires reconciliation");
      throw new ReconciliationRequired(key, "Radicle patch push outcome requires reconciliation");
    }
  }
  async revert(
    receipt: LandingReceipt,
    key: string,
  ): Promise<LandingReceipt> {
    const writes = await this.authorized();
    const patch = receipt.externalId;
    if (receipt.mode !== "radicle_patch" || !patch || !/^[a-f0-9]{40}$/.test(patch) || !key) {
      throw new Error("exact Radicle proposal receipt required");
    }
    const claim = await writes.ledger.begin(key, digest(JSON.stringify([writes.scope, "archive", receipt])));
    if (!claim.fresh) {
      if (claim.record.status === "done") return claim.record.result as LandingReceipt;
      throw new ReconciliationRequired(key, "Radicle proposal withdrawal requires reconciliation");
    }
    const before = await this.snapshot(patch);
    const revisions = before.revisions as Record<string, { oid?: string }> | undefined;
    const latest = Array.isArray(before.timeline) ? before.timeline.at(-1) as string | undefined : undefined;
    if (!latest || revisions?.[latest]?.oid !== receipt.newOid) throw new Unverified("Radicle proposal revision changed");
    if ((before.state as { status?: string } | undefined)?.status !== "open") {
      throw new Unverified("only an open unmerged Radicle proposal can be withdrawn; canonical rollback requires a new approved repair");
    }
    try {
      const result = await this.run(["rad", "patch", "archive", patch, "--repo", this.repository], this.repoDir);
      if (result.code || (await this.snapshot(patch).then(value => value.state) as { status?: string })?.status !== "archived") {
        throw new Unverified("Radicle proposal withdrawal readback");
      }
      const reverted = { ...receipt, at: new Date().toISOString() };
      await writes.ledger.complete(key, reverted);
      return reverted;
    } catch {
      await writes.ledger.markAmbiguous(key, "Radicle proposal withdrawal requires reconciliation");
      throw new ReconciliationRequired(key, "Radicle proposal withdrawal requires reconciliation");
    }
  }
}

/** Commands are constructed but not executed until a Radicle integration is verified. */
export function radicleOpenCommand(head: string, message: string): string[] {
  return [
    "git",
    "push",
    "rad",
    `${head}:refs/patches`,
    "-o",
    `patch.message=${message}`,
  ];
}

export function radicleRevisionCommand(
  head: string,
  patchId: string,
  message: string,
): string[] {
  if (!/^[0-9a-f]{40}$/.test(patchId)) throw new Error("invalid patch id");
  return [
    "git",
    "push",
    "rad",
    `${head}:refs/heads/patches/${patchId}`,
    "-o",
    `patch.message=${message}`,
  ];
}

export function radicleCommentCommand(
  revisionId: string,
  message: string,
): string[] {
  if (!/^[0-9a-f]{40}$/.test(revisionId))
    throw new Error("invalid revision id");
  return ["rad", "patch", "comment", revisionId, "--message", message];
}

/** Parse the documented git-remote-rad output; unknown output is never treated as success. */
export function parseRadiclePush(output: string): {
  kind: "opened" | "updated";
  patchId: string;
} {
  const opened = output.match(/Patch ([0-9a-f]{40}) opened/);
  if (opened) return { kind: "opened", patchId: opened[1]! };
  const updated = output.match(/Patch ([0-9a-f]{7,40}) updated to revision/);
  if (updated) return { kind: "updated", patchId: updated[1]! };
  throw new Unverified("unrecognized Radicle push output");
}

/** Decode the documented Radicle COB snapshot. Unknown or incomplete structures fail closed. */
export function parseRadicleCob(
  id: string,
  output: string,
  workspace: string,
  repo: string,
): ForgeEvent[] {
  let patch: any;
  try {
    patch = JSON.parse(output);
  } catch {
    throw new Unverified("Radicle COB JSON");
  }
  if (!patch.revisions || !Array.isArray(patch.timeline))
    throw new Unverified("Radicle COB revisions");
  const events: ForgeEvent[] = [];
  for (const revisionId of patch.timeline) {
    const revision = patch.revisions[revisionId];
    if (
      !revision ||
      !revision.author?.id ||
      !Number.isFinite(revision.timestamp) ||
      !revision.oid
    ) {
      throw new Unverified("Radicle COB revision fields");
    }
    const add = (
      sourceId: string,
      kind: ForgeEvent["kind"],
      actor: string,
      timestamp: number,
      body?: string,
    ) => {
      const payload = JSON.stringify([
        id,
        revisionId,
        sourceId,
        actor,
        timestamp,
        body,
      ]);
      events.push({
        workspace,
        repo,
        adapter: "radicle",
        sourceId,
        cursor: "",
        occurredAt: new Date(timestamp).toISOString(),
        kind,
        objectId: id,
        revision: revisionId,
        commit: revision.oid,
        actor,
        payloadDigest: digest(payload),
        ...(body === undefined ? {} : { body }),
      });
    };
    add(
      `revision:${id}:${revisionId}`,
      revisionId === id ? "proposal.opened" : "proposal.updated",
      revision.author.id,
      revision.timestamp,
    );
    const comments = revision.discussion?.comments;
    if (!comments || typeof comments !== "object")
      throw new Unverified("Radicle COB discussion");
    for (const [commentId, value] of Object.entries(comments)) {
      const comment = value as any;
      const first = comment.edits?.[0];
      if (
        !comment.author ||
        !first ||
        !Number.isFinite(first.timestamp) ||
        typeof first.body !== "string"
      ) {
        throw new Unverified("Radicle COB comment fields");
      }
      add(
        `comment:${id}:${commentId}`,
        "review.comment",
        comment.author,
        first.timestamp,
        first.body,
      );
    }
  }
  return events;
}
