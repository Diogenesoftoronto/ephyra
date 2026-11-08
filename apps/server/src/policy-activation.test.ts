import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import type { Draft } from "@ephyra/core";
import { PolicyDocs, sha256 } from "./docs.ts";
import { writePolicyRef } from "./policy-ref.ts";
import { ACTIVE_POLICY_REF, PolicyActivation, type PolicyActivationRequest } from "./policy-activation.ts";
import type { Git } from "./wiring/landing.ts";
import { MemoryAudit, type AuditInput } from "./audit.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const at = new Date("2026-11-08T12:00:00.000Z");
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-policy-activation-"));
  directories.push(directory);
  await Bun.spawn(["git", "init", "--bare", "-q", directory]).exited;
  const git: Git = async (args, opts) => {
    const command = Bun.spawn(["git", "--git-dir", directory, ...args], {
      stdin: opts?.input !== undefined ? new Blob([opts.input]) : "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...opts?.env },
    });
    const [out, err, exit] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited]);
    if (exit) throw new Error(err);
    return out;
  };
  let activation: PolicyActivation;
  const applied: Record<string, string>[] = [];
  const audited: string[] = [];
  const audit = new MemoryAudit();
  const docs = new PolicyDocs({ git, baseRef: "refs/heads/main", activeContent: (path) => activation?.content(path) ?? Promise.resolve(null),
    activePaths: () => activation?.paths() ?? Promise.resolve([]) });
  const options = { git, docs, now: () => at, audit: { append: async (input: AuditInput) => {
    if (audited.includes(input.id)) throw new Error("audit id reused");
    audited.push(input.id); return audit.append(input);
  } },
    apply: async (documents: Record<string, string>) => { applied.push(documents); } };
  activation = new PolicyActivation(options);
  async function publish(id: string, path: string, content: string): Promise<Draft> {
    const initial = await docs.content(path) ?? "";
    const published = await writePolicyRef(git, { draftId: id, path, content, approver: "did:plc:owner", baseRef: "refs/heads/main", at });
    return { id, path, kind: path === "autonomy.md" ? "autonomy" : path === "thresholds.yaml" ? "thresholds" : "intent",
      baseDigest: sha256(initial), content, warnings: [], status: "published", createdBy: "did:plc:owner", createdAt: at.toISOString(),
      updatedAt: at.toISOString(), messages: [], published: { ...published, by: "did:plc:owner", at: at.toISOString() } };
  }
  const request = (draft: Draft, key: string, expectedActive: string | null = null): PolicyActivationRequest => ({
    principal: "did:plc:owner", key, expectedActive, expectedCommit: draft.published!.commit, expectedDigest: sha256(draft.content),
  });
  return { git, docs, activation, options, applied, audited, publish, request };
}

test("publication and explicit activation remain separate; active policy restores from an exact durable snapshot", async () => {
  const f = await fixture();
  const draft = await f.publish(first, "intents/checkout.md", "# Checkout\n\nA paid order has a receipt.\n");
  expect(await f.activation.current()).toBeNull();
  expect(await f.docs.content(draft.path)).toBeNull();
  const receipt = await f.activation.activate(draft, f.request(draft, "activate-first"));
  expect(receipt.sourceCommit).toBe(draft.published!.commit);
  expect(f.applied.at(-1)![draft.path]).toBe(draft.content);
  expect(f.audited).toHaveLength(1);
  expect((await f.docs.list()).some((doc) => doc.path === draft.path && doc.content === draft.content)).toBe(true);
  expect((await f.git(["rev-parse", ACTIVE_POLICY_REF])).trim()).toBe(receipt.commit);
  const restored: Record<string, string>[] = [];
  await new PolicyActivation({ ...f.options, apply: async (documents) => { restored.push(documents); } }).restore();
  expect(restored[0]![draft.path]).toBe(draft.content);
  expect((await f.git(["for-each-ref", "--format=%(refname)", "refs/heads/"])).trim()).toBe("");
});

test("activating independently drafted documents merges the current active tree; old receipt replay never rolls it back", async () => {
  const f = await fixture();
  const a = await f.publish(first, "intents/a.md", "# A\nKeep A working.\n");
  const b = await f.publish(second, "intents/b.md", "# B\nKeep B working.\n");
  const input = f.request(a, "activate-a");
  const one = await f.activation.activate(a, input);
  const two = await f.activation.activate(b, f.request(b, "activate-b", one.commit));
  expect(f.applied.at(-1)).toMatchObject({ [a.path]: a.content, [b.path]: b.content });
  expect(await f.activation.activate(a, input)).toEqual(one);
  expect((await f.activation.current())!.commit).toBe(two.commit);
  expect(f.applied.at(-1)![b.path]).toBe(b.content);
  expect(f.audited).toHaveLength(2);
});

test("source digest, exact commit, operation key and active version prevent stale or substituted activations", async () => {
  const f = await fixture();
  const a = await f.publish(first, "intents/a.md", "# A\n");
  const b = await f.publish(second, "intents/a.md", "# B\n");
  const input = f.request(a, "activate-a");
  const receipt = await f.activation.activate(a, input);
  await expect(f.activation.activate(a, { ...input, expectedDigest: "f".repeat(64) })).rejects.toThrow("key was used");
  await expect(f.activation.activate(b, f.request(b, "activate-b"))).rejects.toThrow("active policy changed");
  await expect(f.activation.activate(b, f.request(b, "activate-b", receipt.commit))).rejects.toThrow("effective document changed");
  await expect(f.activation.activate(a, { ...f.request(a, "bad-digest", receipt.commit), expectedDigest: "f".repeat(64) })).rejects.toThrow("content changed");
  await f.git(["update-ref", a.published!.ref, b.published!.commit]);
  await expect(f.activation.activate(a, f.request(a, "moved-ref", receipt.commit))).rejects.toThrow("commit changed");
  expect((await f.activation.current())!.commit).toBe(receipt.commit);
});

test("every effective document is validated before activation; invalid published text never changes active state", async () => {
  const f = await fixture();
  const draft = await f.publish(first, "thresholds.yaml", "not valid yaml: [\n");
  await expect(f.activation.activate(draft, f.request(draft, "invalid-thresholds"))).rejects.toThrow("validation errors");
  expect(await f.activation.current()).toBeNull();
  expect(f.applied).toHaveLength(0);
});

test("a persisted activation can finish its local reload without writing a second operation after an interruption", async () => {
  const f = await fixture();
  const draft = await f.publish(first, "intents/a.md", "# A\n");
  let calls = 0;
  const activation = new PolicyActivation({ ...f.options, apply: async () => { if (++calls === 1) throw new Error("reload interrupted"); } });
  const input = f.request(draft, "activation-recovery");
  await expect(activation.activate(draft, input)).rejects.toThrow("reload interrupted");
  const persisted = (await activation.current())!.commit;
  expect((await activation.activate(draft, input)).commit).toBe(persisted);
  expect(calls).toBe(2);
  expect(f.audited).toHaveLength(1);
});

test("two coordinators contend through a git transaction rather than overwrite another active version", async () => {
  const f = await fixture();
  const a = await f.publish(first, "intents/a.md", "# A\n");
  const b = await f.publish(second, "intents/b.md", "# B\n");
  const other = new PolicyActivation(f.options);
  const results = await Promise.allSettled([
    f.activation.activate(a, f.request(a, "activate-race-a")), other.activate(b, f.request(b, "activate-race-b")),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(await f.activation.current()).not.toBeNull();
});

test("arbitrary malformed request keys cannot reach Git", async () => {
  const f = await fixture();
  const draft = await f.publish(first, "intents/a.md", "# A\n");
  const activation = new PolicyActivation({ ...f.options, git: async () => { throw new Error("Git must not be called"); } });
  await fc.assert(fc.asyncProperty(fc.string().filter((key) => !/^[A-Za-z0-9._:-]{8,100}$/.test(key)), async (key) => {
    await expect(activation.activate(draft, { ...f.request(draft, "valid-key"), key })).rejects.toThrow("Invalid policy activation request");
  }), { numRuns: 30 });
});
