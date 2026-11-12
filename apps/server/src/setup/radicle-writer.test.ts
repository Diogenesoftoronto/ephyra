import { expect, test } from "bun:test";
import fc from "fast-check";
import type { ForgeAdapter } from "@ephyra/core";
import { MemoryOperationLedger } from "@ephyra/forge";
import type { ServerContext } from "../wiring/context.ts";
import type { GitProbeCatalog } from "../wiring/probes.ts";
import type { Accounts } from "./accounts.ts";
import { personalLanding } from "./personal-landing.ts";
import { isPatchPush, isPatchRead, radicleWriter, radicleWriterConfig, type EnvRunner } from "./radicle-writer.ts";

const RID = "rad:zWqAfh1Dtwr2gByC8Ln3EpW5jxv1";
const NID = "z6MkjMRqWGT4iy6Ud1MsTGrj7jSKqVwoVtvdvKKuaM6WXBBD";
const OID = "a".repeat(40);

test("only a patch push is a patch push", () => {
  expect(isPatchPush(["git", "push", "rad", `${OID}:refs/patches`, "-o", "patch.message=Fix", "-o", `patch.base=${"b".repeat(40)}`])).toBe(true);
  expect(isPatchPush(["git", "push", "rad", `${OID}:refs/heads/patches/${"c".repeat(40)}`])).toBe(true);
  for (const argv of [
    ["git", "push", "rad", `${OID}:refs/heads/main`],
    ["git", "push", "rad", `${OID}:refs/patches`, "--force"],
    ["git", "push", "rad", `+${OID}:refs/patches`],
    ["git", "push", "--mirror", "rad"],
    ["git", "push", "rad", `${OID}:refs/patches`, "-o", "ci.skip"],
    ["git", "push", "-c", `${OID}:refs/patches`],
    ["rad", "push"],
  ]) expect(isPatchPush(argv)).toBe(false);
  fc.assert(fc.property(fc.string(), (target) => {
    if (isPatchPush(["git", "push", "rad", `${OID}:${target}`])) expect(target === "refs/patches" || target.startsWith("refs/heads/patches/")).toBe(true);
  }));
});

test("only reads of this repository's patches, and archiving one, are allowed rad calls", () => {
  expect(isPatchRead(["rad", "cob", "show", "--repo", RID, "--type", "xyz.radicle.patch", "--object", OID], RID)).toBe(true);
  expect(isPatchRead(["rad", "patch", "archive", OID, "--repo", RID], RID)).toBe(true);
  expect(isPatchRead(["rad", "cob", "show", "--repo", "rad:zOther111111111111111111", "--type", "xyz.radicle.patch"], RID)).toBe(false);
  expect(isPatchRead(["rad", "patch", "merge", OID, "--repo", RID], RID)).toBe(false);
  expect(isPatchRead(["rad", "auth"], RID)).toBe(false);
});

test("the writer seeds once, pushes patches through the rad remote with the identity's environment, and refuses the rest", async () => {
  const calls: { argv: string[]; env?: Record<string, string> }[] = [];
  const base: EnvRunner = async (argv, _cwd, env) => {
    calls.push({ argv, env });
    if (argv[1] === "remote" && argv[2] === "get-url") return { code: 2, stdout: "", stderr: "" };
    if (argv[1] === "node") return { code: 0, stdout: `${NID}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const run = radicleWriter({ home: "/tmp/ephyra-rad-test", passphrase: "rad-pass-secret" }, RID, base);
  await run(["git", "push", "origin", `${OID}:refs/patches`, "-o", "patch.message=Fix"], "/tmp");
  await run(["git", "push", "origin", `${OID}:refs/patches`], "/tmp");
  expect(calls.filter((c) => c.argv[1] === "seed")).toHaveLength(1);
  expect(calls.find((c) => c.argv[2] === "add")!.argv).toEqual(["git", "remote", "add", "rad", `rad://${RID.slice(4)}/${NID}`]);
  const pushes = calls.filter((c) => c.argv[1] === "push");
  expect(pushes.map((c) => c.argv[2])).toEqual(["rad", "rad"]);
  expect(pushes.every((c) => c.env?.RAD_HOME === "/tmp/ephyra-rad-test" && c.env?.RAD_PASSPHRASE === "rad-pass-secret")).toBe(true);
  await expect(run(["git", "push", "rad", `${OID}:refs/heads/main`], "/tmp")).rejects.toThrow("only open patches");
  await expect(run(["rad", "patch", "merge", OID, "--repo", RID], "/tmp")).rejects.toThrow("only open patches");
  expect(() => radicleWriter({ home: "/tmp/x" }, "not-a-rid", base)).toThrow();
});

test("without EPHYRA_RADICLE_HOME the server says why Radicle stays read-only", () => {
  expect(radicleWriterConfig({ EPHYRA_DATA_DIR: "/data" })).toEqual({ config: null, reason: expect.stringContaining("read-only") });
  expect(radicleWriterConfig({ EPHYRA_DATA_DIR: "/data", EPHYRA_RADICLE_HOME: "radicle" }).config).toEqual({ home: "/data/radicle" });
});

test("a Radicle workspace gets a patch adapter only when the server has an identity", async () => {
  const repository = { url: RID, branch: "main", credentialConfigured: false,
    forge: { kind: "radicle", source: RID, repositoryId: RID } };
  const accounts = { record: async () => ({ settings: { workspaceId: "ws-1", repository } }) } as unknown as Accounts;
  const ctx = { repo: { mirrorDir: "/tmp/mirror" } } as unknown as ServerContext;
  const deps = { ctx, ledger: new MemoryOperationLedger(), probes: {} as GitProbeCatalog,
    runProbe: async () => { throw new Error("unused"); }, telemetry: null };
  const none = await personalLanding({ accounts, did: "did:a", workspace: "ws-1" })(deps);
  expect(none.adapters).toEqual([]);
  const seen: string[] = [];
  const withIdentity = await personalLanding({ accounts, did: "did:a", workspace: "ws-1", radicle: { home: "/tmp/r" },
    radicleRunner: (rid) => { seen.push(rid); return async () => ({ code: 0, stdout: "", stderr: "" }); } })(deps);
  expect(withIdentity.adapters.map((a: ForgeAdapter) => a.name)).toEqual(["radicle"]);
  expect(seen).toEqual([RID]);
  expect((await withIdentity.adapters[0]!.capabilities(RID)).landingModes).toEqual(["radicle_patch"]);
});
