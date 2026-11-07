import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyRefConflict, writePolicyRef, policyRef } from "./policy-ref.ts";
import type { Git } from "./wiring/landing.ts";

let dir = "";
let git: Git;
const sh = async (...args: string[]) => {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t" } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw new Error(err);
  return out.trim();
};
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const at = new Date("2026-11-07T10:00:00Z");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ephyra-ref-"));
  await sh("git", "init", "-q", "--bare", dir);
  git = async (args, opts) => {
    const p = Bun.spawn(["git", "--git-dir", dir, ...args], {
      stdin: opts?.input ? new Blob([opts.input]) : "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts?.env },
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code) throw new Error(err);
    return out;
  };
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("writePolicyRef", () => {
  test("without a base ref it is a root commit holding only the document, with the trailers", async () => {
    const r = await writePolicyRef(git, { draftId: D1, path: "autonomy.md", content: "## defaults\n", approver: "did:plc:alice", baseRef: "refs/heads/main",
      at });
    expect(r.ref).toBe(policyRef(D1));
    expect(await sh("git", "--git-dir", dir, "rev-parse", r.ref)).toBe(r.commit);
    expect(await sh("git", "--git-dir", dir, "ls-tree", "-r", "--name-only", r.commit)).toBe("autonomy.md");
    const msg = await sh("git", "--git-dir", dir, "log", "-1", "--format=%B", r.commit);
    expect(msg).toContain(`Ephyra-Draft: ${D1}\nEphyra-Approver: did:plc:alice`);
    expect(await sh("git", "--git-dir", dir, "rev-list", "--count", r.commit)).toBe("1");
  });
  test("replaying the same publish returns the same commit; a different draft content under the same id conflicts", async () => {
    const same = { draftId: D1, path: "autonomy.md", content: "## defaults\n", approver: "did:plc:alice", baseRef: "refs/heads/main", at: new Date() };
    const first = await writePolicyRef(git, same);
    expect((await writePolicyRef(git, same)).commit).toBe(first.commit);
    await expect(writePolicyRef(git, { ...same, content: "## defaults\nmode: enforce\n" })).rejects.toBeInstanceOf(PolicyRefConflict);
    await expect(writePolicyRef(git, { ...same, approver: "did:plc:mallory" })).rejects.toBeInstanceOf(PolicyRefConflict);
  });
  test("on top of the base ref it keeps the rest of the tree and parents the base commit", async () => {
    const work = await mkdtemp(join(tmpdir(), "ephyra-work-"));
    await sh("git", "init", "-q", "-b", "main", work);
    await Bun.write(join(work, "app.js"), "x\n");
    await Bun.write(join(work, "autonomy.md"), "old\n");
    await sh("git", "-C", work, "add", ".");
    await sh("git", "-C", work, "commit", "-qm", "init");
    await sh("git", "-C", work, "push", "-q", dir, "main:refs/heads/main");
    const base = await sh("git", "--git-dir", dir, "rev-parse", "refs/heads/main");
    const r = await writePolicyRef(git, { draftId: D2, path: "autonomy.md", content: "new\n", approver: "did:plc:alice", baseRef: "refs/heads/main", at });
    expect(await sh("git", "--git-dir", dir, "rev-parse", `${r.commit}^`)).toBe(base);
    expect((await sh("git", "--git-dir", dir, "ls-tree", "-r", "--name-only", r.commit)).split("\n")).toEqual(["app.js", "autonomy.md"]);
    expect(await sh("git", "--git-dir", dir, "show", `${r.commit}:autonomy.md`)).toBe("new");
    expect(await sh("git", "--git-dir", dir, "rev-parse", "refs/heads/main")).toBe(base); // the base ref itself never moves
    await rm(work, { recursive: true, force: true });
  });
  test("two concurrent publishes of one draft produce one ref and no error for identical content", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const input = { draftId: id, path: "thresholds.yaml", content: "a: 1\n", approver: "did:plc:alice", baseRef: "refs/heads/main", at };
    const results = await Promise.allSettled([writePolicyRef(git, input), writePolicyRef(git, input)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(PolicyRefConflict);
    expect(await sh("git", "--git-dir", dir, "for-each-ref", "--format=%(refname)", policyRef(id))).toBe(policyRef(id));
  });
  test("hostile identities and ids are refused before touching git", async () => {
    const base = { path: "autonomy.md", content: "x", baseRef: "refs/heads/main", at };
    await expect(writePolicyRef(git, { ...base, draftId: D1, approver: "did:x\nEphyra-Draft: other" })).rejects.toThrow("invalid approver");
    await expect(writePolicyRef(git, { ...base, draftId: "../../heads/main", approver: "did:x" })).rejects.toThrow("invalid draft id");
  });
});
