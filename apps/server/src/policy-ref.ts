// Writes a published draft to refs/ephyra/policy/<draft-id>. The policy in effect changes only when that commit lands on the base ref
// through the usual forge landing; nothing here edits the live policy.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Git } from "./wiring/landing.ts";

export class PolicyRefConflict extends Error {}
const DRAFT_ID = /^[0-9a-zA-Z-]{8,64}$/;

export const policyRef = (draftId: string): string => `refs/ephyra/policy/${draftId}`;

const IDENTITY = {
  GIT_AUTHOR_NAME: "Ephyra", GIT_AUTHOR_EMAIL: "policy@ephyra.invalid",
  GIT_COMMITTER_NAME: "Ephyra", GIT_COMMITTER_EMAIL: "policy@ephyra.invalid",
};

async function optional(git: Git, args: string[]): Promise<string | null> {
  try { return (await git(args)).trim(); } catch { return null; }
}

export type PolicyCommit = { draftId: string; path: string; content: string; approver: string; baseRef: string; at: Date };

/**
 * Commits `content` at `path` on top of the base ref's tree (or as a root commit when the base ref doesn't exist yet) and creates the
 * policy ref with compare-and-swap (create only). Replaying the same publish after a crash finds the ref already holding an identical commit
 * and returns it; a ref that holds anything else is a conflict.
 */
export async function writePolicyRef(git: Git, c: PolicyCommit): Promise<{ ref: string; commit: string }> {
  if (!DRAFT_ID.test(c.draftId)) throw new Error("invalid draft id");
  // The approver DID goes into the commit message: refuse anything that could add a trailer or hide one.
  if (/[\x00-\x1f\x7f]/.test(c.approver) || !c.approver.trim()) throw new Error("invalid approver identity");
  const ref = policyRef(c.draftId);
  const trailers = `Ephyra-Draft: ${c.draftId}\nEphyra-Approver: ${c.approver}`;

  const existing = await optional(git, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (existing) {
    const message = (await optional(git, ["log", "-1", "--format=%B", existing])) ?? "";
    const stored = await optional(git, ["show", `${existing}:${c.path}`]);
    if (message.includes(trailers) && stored !== null && stored === c.content.trim()) return { ref, commit: existing };
    throw new PolicyRefConflict(`${ref} already holds a different commit`);
  }

  const blob = (await git(["hash-object", "-w", "--stdin"], { input: c.content })).trim();
  const parent = await optional(git, ["rev-parse", "--verify", "-q", `${c.baseRef}^{commit}`]);
  const dir = await mkdtemp(join(tmpdir(), "ephyra-policy-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    if (parent) await git(["read-tree", parent], { env });
    await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${c.path}`], { env });
    const tree = (await git(["write-tree"], { env })).trim();
    const date = c.at.toISOString();
    const commit = (await git(["commit-tree", tree, ...(parent ? ["-p", parent] : [])], {
      input: `policy: update ${c.path}\n\n${trailers}\n`, env: { ...IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })).trim();
    try {
      await git(["update-ref", ref, commit, "0".repeat(commit.length)]);
    } catch (error) {
      // Someone created the ref between our check and the write; accept it only if it is the same publish.
      if (await optional(git, ["rev-parse", "--verify", "-q", ref])) throw new PolicyRefConflict(`${ref} was created concurrently`);
      throw error;
    }
    return { ref, commit };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
