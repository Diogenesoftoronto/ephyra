import {
  Trail,
  TrailEvent,
  ProofBundle,
  type Journal,
  type JournalFiles,
  type Clock,
} from "@ephyra/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export class JournalConflict extends Error {
  constructor(message = "journal ref conflict") {
    super(message);
    this.name = "JournalConflict";
  }
}
export class JournalCorrupt extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "JournalCorrupt";
  }
}
export class PinConflict extends JournalConflict {
  constructor() {
    super("immutable pin");
    this.name = "PinConflict";
  }
}
export class TrailExists extends JournalConflict {
  constructor() {
    super("trail already exists");
    this.name = "TrailExists";
  }
}
import { run, must } from "./git.ts";
import { canonicalJson } from "./canonical.ts";
const uuid = (id: string) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error("invalid trail id");
  return id;
};
const pathOk = (p: string) => {
  if (
    !p ||
    p.startsWith("/") ||
    p.split("/").some((x) => !x || x === "." || x === "..") ||
    p.includes("\0")
  )
    throw new Error("invalid path");
  return p;
};
const ref = (id: string) => `refs/ephyra/trails/${uuid(id)}`;
export class GitJournal implements Journal {
  constructor(private readonly options: { gitDir: string; clock: Clock }) {}
  private git(
    args: string[],
    input?: string | Uint8Array,
    env?: Record<string, string>,
  ) {
    return must(args, { gitDir: this.options.gitDir, input, env });
  }
  private async head(r: string) {
    const x = await run(["rev-parse", "--verify", "--quiet", r], {
      gitDir: this.options.gitDir,
    });
    if (x.code === 1) return null;
    if (x.code) throw new Error(x.err);
    return x.text;
  }
  private async tree(parent: string | null, files: JournalFiles) {
    const dir = await mkdtemp(join(tmpdir(), "ephyra-index-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      await this.git(
        parent ? ["read-tree", `${parent}^{tree}`] : ["read-tree", "--empty"],
        undefined,
        env,
      );
      for (const [p, data] of Object.entries(files)) {
        pathOk(p);
        const blob = (await this.git(["hash-object", "-w", "--stdin"], data))
          .text;
        await this.git(
          ["update-index", "--add", "--cacheinfo", `100644,${blob},${p}`],
          undefined,
          env,
        );
      }
      return (await this.git(["write-tree"], undefined, env)).text;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  private async commit(tree: string, parent: string | null) {
    const date = this.options.clock.now().toISOString();
    return (
      await this.git(
        ["commit-tree", tree, ...(parent ? ["-p", parent] : [])],
        "Ephyra journal\n",
        {
          GIT_AUTHOR_NAME: "Ephyra",
          GIT_AUTHOR_EMAIL: "journal@ephyra.invalid",
          GIT_COMMITTER_NAME: "Ephyra",
          GIT_COMMITTER_EMAIL: "journal@ephyra.invalid",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      )
    ).text;
  }
  private async update(r: string, value: string, old: string | null) {
    const z = "0".repeat(value.length);
    const x = await run(["update-ref", r, value, old ?? z], {
      gitDir: this.options.gitDir,
    });
    if (x.code) {
      if ((await this.head(r)) !== old) throw new JournalConflict();
      throw new Error(x.err);
    }
  }
  async create(trail: Trail, first: TrailEvent, files: JournalFiles = {}) {
    return this.write(trail.id, null, trail, [first], files);
  }
  async append(
    id: string,
    expected: string,
    trail: Trail,
    events: TrailEvent[],
    files: JournalFiles = {},
  ) {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(expected))
      throw new Error("invalid head");
    return this.write(id, expected, trail, events, files);
  }
  private async write(
    id: string,
    old: string | null,
    trail: Trail,
    events: TrailEvent[],
    files: JournalFiles,
  ) {
    Trail.parse(trail);
    events.forEach((e) => TrailEvent.parse(e));
    if (trail.id !== id || events.some((e) => e.trail !== id))
      throw new Error("trail mismatch");
    if ((await this.head(`${ref(id)}/journal`)) !== old) {
      if (old === null) throw new TrailExists();
      throw new JournalConflict();
    }
    const current = old ? await this.readAt(id, old) : null;
    const ids = current?.events.map((e) => e.id) ?? [];
    for (const e of events) {
      if (ids.includes(e.id)) throw new JournalConflict("duplicate event");
      ids.push(e.id);
    }
    for (const p of Object.keys(files))
      if (
        p === "trail.json" ||
        p === "events-order.json" ||
        p.startsWith("events/")
      )
        throw new Error("reserved path");
    const all: JournalFiles = {
      ...files,
      "trail.json": canonicalJson(trail),
      "events-order.json": canonicalJson(ids),
    };
    for (const e of events) all[`events/${e.id}.json`] = canonicalJson(e);
    const commit = await this.commit(await this.tree(old, all), old);
    try {
      await this.update(`${ref(id)}/journal`, commit, old);
    } catch (error) {
      if (old === null && error instanceof JournalConflict) throw new TrailExists();
      throw error;
    }
    return commit;
  }
  private async fileAt(head: string, path: string) {
    const x = await run(["show", `${head}:${pathOk(path)}`], {
      gitDir: this.options.gitDir,
    });
    return x.code ? null : x.bytes;
  }
  private async readAt(id: string, head: string) {
    let path = "trail.json";
    try {
      const read = async (p: string) => {
        path = p;
        const b = await this.fileAt(head, p);
        if (!b) throw new Error(`missing ${p}`);
        return JSON.parse(new TextDecoder().decode(b));
      };
      const trail = Trail.parse(await read("trail.json"));
      if (trail.id !== id) throw new Error("trail mismatch");
      const ids: unknown = await read("events-order.json");
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length)
        throw new Error("invalid event order");
      const events: TrailEvent[] = [];
      for (const item of ids) {
        if (typeof item !== "string") throw new Error("invalid event id");
        uuid(item);
        const e = TrailEvent.parse(await read(`events/${item}.json`));
        if (e.id !== item || e.trail !== id) throw new Error("event mismatch");
        events.push(e);
      }
      return { head, trail, events };
    } catch (e) {
      throw new JournalCorrupt(path, `invalid journal: ${String(e)}`);
    }
  }
  async read(id: string) {
    const h = await this.head(`${ref(id)}/journal`);
    return h ? this.readAt(id, h) : null;
  }
  async readFile(id: string, path: string) {
    const h = await this.head(`${ref(id)}/journal`);
    return h ? this.fileAt(h, path) : null;
  }
  async list() {
    const r = await this.git([
      "for-each-ref",
      "--format=%(refname)",
      "refs/ephyra/trails/",
    ]);
    return r.text.split("\n").flatMap((x) => {
      const m = /^refs\/ephyra\/trails\/([^/]+)\/journal$/.exec(x);
      return m?.[1] ? [m[1]] : [];
    });
  }
  private pinRef(id: string, kind: string, n: number) {
    if (!Number.isInteger(n) || n < 1 || n > 9999)
      throw new Error("invalid revision");
    return `${ref(id)}/${kind}/${String(n).padStart(4, "0")}`;
  }
  async pinRevision(id: string, n: number, commit: string) {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit))
      throw new Error("invalid commit");
    await this.git(["cat-file", "-e", `${commit}^{commit}`]);
    const r = this.pinRef(id, "revisions", n);
    const old = await this.head(r);
    if (old === commit) return;
    if (old) throw new PinConflict();
    try {
      await this.update(r, commit, null);
    } catch (e) {
      if (e instanceof JournalConflict && (await this.head(r)) === commit)
        return;
      if (e instanceof JournalConflict) throw new PinConflict();
      throw e;
    }
  }
  async pinProof(id: string, n: number, bundle: ProofBundle) {
    ProofBundle.parse(bundle);
    const json = canonicalJson(bundle);
    const digest = `sha256:${createHash("sha256").update(json).digest("hex")}`;
    const r = this.pinRef(id, "proofs", n);
    let old = await this.head(r);
    if (old) {
      const bytes = await this.fileAt(old, "proof/manifest.json");
      if (bytes && new TextDecoder().decode(bytes) === json)
        return { digest, commit: old };
      throw new PinConflict();
    }
    const commit = await this.commit(
      await this.tree(null, { "proof/manifest.json": json }),
      null,
    );
    try {
      await this.update(r, commit, null);
    } catch (e) {
      old = await this.head(r);
      if (e instanceof JournalConflict && old) {
        const b = await this.fileAt(old, "proof/manifest.json");
        if (b && new TextDecoder().decode(b) === json)
          return { digest, commit: old };
      }
      if (e instanceof JournalConflict) throw new PinConflict();
      throw e;
    }
    return { digest, commit };
  }
  async exportBundle(ids: string[] | "all", path: string) {
    const refs = (
      await this.git([
        "for-each-ref",
        "--format=%(refname)",
        "refs/ephyra/trails/",
      ])
    ).text
      .split("\n")
      .filter(Boolean)
      .filter(
        (r) => ids === "all" || ids.some((id) => r.startsWith(`${ref(id)}/`)),
      );
    if (!refs.length) throw new Error("no refs to export");
    await this.git(["bundle", "create", path, ...refs]);
  }
  async importBundle(path: string) {
    await this.git(["fetch", "--no-tags", path, "refs/ephyra/*:refs/ephyra/*"]);
  }
  async probeRemoteCustomRefs(
    remote: string,
  ): Promise<"supported" | "unsupported" | "unknown"> {
    const h = (
      await this.git([
        "for-each-ref",
        "--count=1",
        "--format=%(objectname)",
        "refs/ephyra/trails/",
      ])
    ).text;
    if (!h || remote.startsWith("-")) return "unknown";
    const probe = `refs/ephyra/probes/${crypto.randomUUID()}`;
    const result = await run(["push", "--porcelain", remote, `${h}:${probe}`], {
      gitDir: this.options.gitDir,
    });
    if (result.code) {
      return /prohibited|denied|reject|not permitted/i.test(
        result.err + result.text,
      )
        ? "unsupported"
        : "unknown";
    }
    const cleanup = await run(["push", remote, `:${probe}`], {
      gitDir: this.options.gitDir,
    });
    return cleanup.code ? "unknown" : "supported";
  }
}
