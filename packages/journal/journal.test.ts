import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitJournal,
  CompanionJournal,
  JournalConflict,
  JournalCorrupt,
  PinConflict,
  TrailExists,
  canonicalJson,
  formatTrailers,
  parseTrailers,
  configureRefspecs,
} from "./src/index.ts";
import { proofDigest, Trail, TrailEvent } from "@ephyra/core";
const id = "018f0000-0000-7000-8000-000000000001";
const at = "2026-01-01T00:00:00Z";
const trail = Trail.parse({
  schema: 1,
  id,
  short: "T",
  repo: "repo",
  title: "test",
  rev: 1,
  state: "sensed",
  signals: [],
  area: "a",
  risk: "low",
  route: "auto_fix",
  severity: 1,
  base: { ref: "main", sha: "a".repeat(40) },
  checkpoints: { spend: [] },
  attempts: { proof: 0, maxProof: 3 },
  budget: {
    tokensUsed: 0,
    tokensMax: 1,
    wallclockMaxS: 1,
    spendMicrousdUsed: 0,
    spendMicrousdMax: 0,
  },
  createdAt: at,
  updatedAt: at,
});
const event = (n: number) =>
  TrailEvent.parse({
    schema: 1,
    id: `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    trail: id,
    rev: 1,
    at,
    actor: { kind: "system", id: "test" },
    type: "human_comment",
    data: { text: "hello", isRequest: false },
  });
async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  if (await p.exited) throw new Error(err);
  return out.trim();
}
test("journal CAS, order, files, pins and bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "journal-test-"));
  try {
    await git(dir, "init", "--bare", "repo.git");
    await git(dir, "init", "--bare", "other.git");
    const j = new GitJournal({
      gitDir: join(dir, "repo.git"),
      clock: { now: () => new Date(at) },
    });
    const h = await j.create(trail, event(1), { "hypothesis.md": "hello" });
    const results = await Promise.allSettled([
      j.append(id, h, trail, [event(2)]),
      j.append(id, h, trail, [event(3)]),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(
      results.filter(
        (x) => x.status === "rejected" && x.reason instanceof JournalConflict,
      ),
    ).toHaveLength(1);
    expect((await j.read(id))?.events).toHaveLength(2);
    expect(
      new TextDecoder().decode((await j.readFile(id, "hypothesis.md"))!),
    ).toBe("hello");
    await j.pinRevision(id, 1, h);
    await j.pinRevision(id, 1, h);
    await expect(
      j.pinRevision(id, 1, (await j.read(id))!.head),
    ).rejects.toBeInstanceOf(JournalConflict);
    expect(await j.list()).toEqual([id]);
    expect(await j.probeRemoteCustomRefs(join(dir, "other.git"))).toBe(
      "supported",
    );
    const bundle = join(dir, "out.bundle");
    await j.exportBundle("all", bundle);
    const other = new GitJournal({
      gitDir: join(dir, "other.git"),
      clock: { now: () => new Date(at) },
    });
    await other.importBundle(bundle);
    expect(await other.read(id)).toEqual(await j.read(id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("canonical JSON and trailers", async () => {
  expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
    '{"a":{"x":3,"y":2},"z":1}',
  );
  const t = formatTrailers({
    trail: id,
    proofDigest: "sha256:abc",
    entireCheckpoints: ["real"],
  });
  expect(await parseTrailers(`message\n\n${t}\n`)).toHaveLength(3);
});
test("refspecs are idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "journal-test-"));
  try {
    await git(dir, "init");
    await git(dir, "remote", "add", "origin", "unused");
    await configureRefspecs(dir, "origin");
    await configureRefspecs(dir, "origin");
    expect(
      (await git(dir, "config", "--get-all", "remote.origin.push")).split("\n"),
    ).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("append sequences preserve order and leave application checkout intact", async () => {
  const fc = await import("fast-check");
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (count) => {
      const dir = await mkdtemp(join(tmpdir(), "journal-property-"));
      try {
        await git(dir, "init");
        await Bun.write(join(dir, "file"), "original\n");
        await git(dir, "add", "file");
        await git(
          dir,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "initial",
        );
        await Bun.write(join(dir, "file"), "modified\n");
        const before = await Bun.file(join(dir, ".git/index")).bytes();
        const head = await git(dir, "rev-parse", "HEAD");
        const j = new GitJournal({
          gitDir: join(dir, ".git"),
          clock: { now: () => new Date(at) },
        });
        let h = await j.create(trail, event(1));
        for (let i = 0; i < count; i++)
          h = await j.append(id, h, trail, [event(i + 2)]);
        expect((await j.read(id))!.events.map((e) => e.id)).toEqual(
          Array.from({ length: count + 1 }, (_, i) => event(i + 1).id),
        );
        expect(await git(dir, "rev-parse", "HEAD")).toBe(head);
        expect(await Bun.file(join(dir, ".git/index")).bytes()).toEqual(before);
        expect(await Bun.file(join(dir, "file")).text()).toBe("modified\n");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
    { numRuns: 8 },
  );
});

test("proof pins are immutable and canonical JSON rejects nonfinite numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "journal-proof-"));
  try {
    await git(dir, "init", "--bare", "repo.git");
    const j = new GitJournal({
      gitDir: join(dir, "repo.git"),
      clock: { now: () => new Date(at) },
    });
    await j.create(trail, event(1));
    await expect(j.create(trail, event(1))).rejects.toBeInstanceOf(TrailExists);
    const proof = {
      schema: 1 as const,
      trail: id,
      rev: 1,
      risk: "low" as const,
      base: "a".repeat(40),
      head: "b".repeat(40),
      items: [],
      passed: false,
      missing: [],
      env: { runner: "test" },
      computedAt: at,
    };
    const first = await j.pinProof(id, 1, proof);
    expect(first.digest).toBe(proofDigest(proof));
    expect(await j.pinProof(id, 1, proof)).toEqual(first);
    await expect(
      j.pinProof(id, 1, { ...proof, passed: true }),
    ).rejects.toBeInstanceOf(PinConflict);
    expect(() => canonicalJson({ x: Infinity })).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remote hook rejection is detected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "journal-probe-"));
  try {
    await git(dir, "init", "--bare", "local.git");
    await git(dir, "init", "--bare", "remote.git");
    const hook = join(dir, "remote.git/hooks/pre-receive");
    await writeFile(
      hook,
      "#!/bin/sh\nwhile read old new ref; do case $ref in refs/ephyra/*) exit 1;; esac; done\nexit 0\n",
    );
    await chmod(hook, 0o755);
    const j = new GitJournal({
      gitDir: join(dir, "local.git"),
      clock: { now: () => new Date(at) },
    });
    await j.create(trail, event(1));
    expect(await j.probeRemoteCustomRefs(join(dir, "remote.git"))).toBe(
      "unsupported",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["{", JSON.stringify({ schema: 1, id })])(
  "corrupt or schema-invalid trail reports its path: %s",
  async (bad) => {
    const dir = await mkdtemp(join(tmpdir(), "journal-corrupt-"));
    try {
      await git(dir, "init", "--bare", "repo.git");
      const repo = join(dir, "repo.git");
      const j = new GitJournal({
        gitDir: repo,
        clock: { now: () => new Date(at) },
      });
      const head = await j.create(trail, event(1));
      const index = join(dir, "index");
      const run = async (...args: string[]) => {
        const p = Bun.spawn(["git", `--git-dir=${repo}`, ...args], {
          env: {
            ...process.env,
            GIT_INDEX_FILE: index,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        if (await p.exited) throw new Error(err);
        return out.trim();
      };
      await Bun.write(join(dir, "bad"), bad);
      const blob = await run("hash-object", "-w", join(dir, "bad"));
      await run("read-tree", `${head}^{tree}`);
      await run("update-index", "--cacheinfo", `100644,${blob},trail.json`);
      const tree = await run("write-tree");
      const commit = await run("commit-tree", tree, "-m", "corrupt");
      await run("update-ref", `refs/ephyra/trails/${id}/journal`, commit, head);
      try {
        await j.read(id);
        throw new Error("expected corruption");
      } catch (error) {
        expect(error).toBeInstanceOf(JournalCorrupt);
        expect((error as JournalCorrupt).path).toBe("trail.json");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("selected-trail bundle includes only the chosen trail and its pins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "journal-selected-"));
  try {
    await git(dir, "init", "--bare", "source.git");
    await git(dir, "init", "--bare", "target.git");
    const clock = { now: () => new Date(at) };
    const source = new GitJournal({ gitDir: join(dir, "source.git"), clock });
    const target = new GitJournal({ gitDir: join(dir, "target.git"), clock });
    const otherId = "018f0000-0000-7000-8000-000000000002";
    const head = await source.create(trail, event(1));
    await source.pinRevision(id, 1, head);
    await source.create(
      { ...trail, id: otherId },
      { ...event(2), trail: otherId },
    );
    const bundle = join(dir, "selected.bundle");
    await source.exportBundle([id], bundle);
    await target.importBundle(bundle);
    expect(await target.read(id)).toEqual(await source.read(id));
    expect(await target.read(otherId)).toBeNull();
    expect(await target.list()).toEqual([id]);
    expect(
      await git(
        dir,
        `--git-dir=${join(dir, "target.git")}`,
        "rev-parse",
        `refs/ephyra/trails/${id}/revisions/0001`,
      ),
    ).toBe(head);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("companion journal keeps canonical trail ids in its separate bare repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "journal-companion-"));
  try {
    await git(dir, "init", "--bare", "app.git");
    await git(dir, "init", "--bare", "companion.git");
    const clock = { now: () => new Date(at) };
    const app = new GitJournal({ gitDir: join(dir, "app.git"), clock });
    const companion = new CompanionJournal({
      gitDir: join(dir, "companion.git"),
      clock,
    });
    const head = await companion.create(trail, event(1), {
      "evidence.txt": "data",
    });
    await companion.append(id, head, trail, [event(2)]);
    expect(await companion.list()).toEqual([id]);
    expect((await companion.read(id))?.events.map((e) => e.id)).toEqual([
      event(1).id,
      event(2).id,
    ]);
    expect(
      new TextDecoder().decode((await companion.readFile(id, "evidence.txt"))!),
    ).toBe("data");
    expect(await app.read(id)).toBeNull();
    expect(await app.list()).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
