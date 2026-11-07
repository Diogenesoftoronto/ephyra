import {
  Unverified,
  type ForgeAdapter,
  type ForgeCapabilities,
  type ForgeEvent,
  type LandingPlan,
  type LandingReceipt,
  type LandingMode,
  type Trail,
} from "@ephyra/core";
import { caps, digest } from "./common";
import { commandRunner, type CommandRunner } from "./command";
export class RadicleAdapter implements ForgeAdapter {
  readonly name = "radicle";
  constructor(
    private readonly repoDir = ".",
    private readonly repository = "",
    private readonly run: CommandRunner = commandRunner,
    private readonly workspace = "default",
  ) {}
  async capabilities(): Promise<ForgeCapabilities> {
    return { ...caps(this.name, ["radicle_patch"], false), proposals: true };
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
    _trail: Trail,
    _mode: LandingMode,
    _base: string,
  ): Promise<LandingPlan> {
    throw new Unverified("Radicle landing preparation");
  }
  // Patch push and CI event reference: https://radicle-ci-broker.liw.fi/userguide.html
  async land(
    _plan: LandingPlan,
    _auth: string,
    _key: string,
  ): Promise<LandingReceipt> {
    throw new Unverified("Radicle patch push and receipt");
  }
  async revert(
    _receipt: LandingReceipt,
    _key: string,
  ): Promise<LandingReceipt> {
    throw new Unverified("Radicle revert");
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
