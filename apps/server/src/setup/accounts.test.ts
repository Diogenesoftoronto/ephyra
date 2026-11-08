import { describe, expect, test } from "bun:test";
import type { ModelUpdate } from "@ephyra/core";
import { SecretBox, type Fetch } from "../auth/crypto";
import { NotOrganicSignIn } from "../auth/notorganic";
import { fakeNotOrganic } from "../auth/notorganic.fixture";
import { MemoryAuthStore } from "../auth/store";
import { MemoryAccountStore } from "./account-store";
import { Accounts, workspaceId } from "./accounts";
import type { RepositoryInput } from "./repository";

const DID = "did:plc:alice";
const OTHER = "did:plc:bob";
const KEY = "test-private-model-key-123456";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

async function fixture(fetcher: Fetch = async () => json({ data: [{ id: "chosen-model" }] })) {
  const box = await SecretBox.fromBase64(Buffer.alloc(32, 7).toString("base64"));
  const store = new MemoryAccountStore();
  const fake = fakeNotOrganic({ approved: true, product: "ephyra", did: DID });
  const signIn = new NotOrganicSignIn(
    {
      issuer: "https://api.notorganic.test",
      authorizationUrl: "https://id.notorganic.test/authorize",
      publicOrigin: "https://ephyra.example",
      product: "ephyra",
      scopes: ["judgement:evaluate"],
    },
    new MemoryAuthStore(),
    box,
    fake.fetcher,
  );
  const connections: { input: RepositoryInput; directory: string }[] = [];
  const changes: [string, string][] = [];
  const service = new Accounts({
    store,
    box,
    operationSecret: "fixture-secret",
    dataDir: "/tmp/ephyra-account-unit",
    signIn,
    fetcher,
    repository: {
      prepare: async (input, directory) => {
        connections.push({ input, directory });
        return { url: input.url, branch: input.branch, head: "a".repeat(40), verifiedAt: "2026-11-07T10:00:00.000Z" };
      },
    },
    onWorkspaceChange: (before, after) => changes.push([before, after]),
  });
  return { service, store, box, connections, changes };
}

describe("account configuration service", () => {
  test("model keys are sealed and write-only; operation replay does not revalidate or replace the original receipt", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const f = await fixture(async (url, init) => {
      calls.push({ url, headers: new Headers(init?.headers) });
      return json({ data: [{ id: "chosen-model" }] });
    });
    const input: ModelUpdate = {
      expectedVersion: 0,
      provider: "compatible",
      model: "chosen-model",
      baseUrl: "https://models.example/v1",
      apiKey: KEY,
    };
    const saved = await f.service.saveModel(DID, input, "model-save-0001");
    expect(saved).toMatchObject({
      did: DID,
      version: 1,
      model: { status: "verified", keyConfigured: true, model: "chosen-model" },
    });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://models.example/v1/models");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    const stored = (await f.store.get(DID))!;
    expect(stored.modelKey).not.toBe(KEY);
    expect(await f.box.open(stored.modelKey!)).toBe(KEY);
    expect(await f.service.saveModel(DID, input, "model-save-0001")).toEqual(saved);
    expect(calls).toHaveLength(1);
    await expect(
      f.service.saveModel(DID, { ...input, apiKey: "another-key" }, "model-save-0001"),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
    expect((await f.service.settings(OTHER)).model.keyConfigured).toBe(false);
  });

  test("keys follow the exact saved provider destination and explicit removal disables model use", async () => {
    const calls: string[] = [];
    const f = await fixture(async (url) => {
      calls.push(url);
      return json({ data: [{ id: "chosen-model" }] });
    });
    await f.service.saveModel(
      DID,
      {
        expectedVersion: 0,
        provider: "compatible",
        model: "chosen-model",
        baseUrl: "https://one.example/v1",
        apiKey: KEY,
      },
      "model-first-0001",
    );
    const retained = await f.service.saveModel(
      DID,
      { expectedVersion: 1, provider: "compatible", model: "changed-model", baseUrl: "https://one.example/v1" },
      "model-second-0002",
    );
    expect(retained.model.keyConfigured).toBe(true);
    expect(calls).toHaveLength(2);
    const switched = await f.service.saveModel(
      DID,
      { expectedVersion: 2, provider: "compatible", model: "chosen-model", baseUrl: "https://two.example/v1" },
      "model-third-0003",
    );
    expect(switched.model).toMatchObject({ keyConfigured: false, status: "not_configured" });
    expect(calls).toHaveLength(2);
    expect((await f.store.get(DID))!.modelKey).toBeUndefined();
    expect(await f.service.modelFor(DID, switched.workspaceId)).toBeNull();
    await f.service.saveModel(
      DID,
      { expectedVersion: 3, provider: "openai", model: "chosen-model", apiKey: KEY },
      "model-fourth-0004",
    );
    const removed = await f.service.saveModel(
      DID,
      { expectedVersion: 4, provider: "openai", model: "chosen-model", clearKey: true },
      "model-remove-0005",
    );
    expect(removed.model.keyConfigured).toBe(false);
    expect(await f.service.modelFor(DID, removed.workspaceId)).toBeNull();
    expect((await f.store.get(DID))!.modelKey).toBeUndefined();
    await expect(f.service.modelFor(DID, workspaceId(OTHER))).rejects.toThrow("no longer selected");
  });

  test("provider errors and failed-operation receipts never expose upstream key-bearing failures", async () => {
    let calls = 0;
    const f = await fixture(async () => {
      calls++;
      throw new Error(`upstream echoed ${KEY}`);
    });
    const input: ModelUpdate = { expectedVersion: 0, provider: "openai", model: "chosen-model", apiKey: KEY };
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await f.service.saveModel(DID, input, "failing-save-0001").catch((error) => error);
      expect(error.status).toBe(422);
      expect(error.message).not.toContain(KEY);
      expect(error.message).toContain("could not be verified");
    }
    expect(calls).toBe(1);
    expect((await f.service.settings(DID)).version).toBe(0);
    expect((await f.store.get(DID))!.modelKey).toBeUndefined();
  });

  test("in-flight replay is refused; concurrent distinct saves cannot overwrite the CAS winner", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const f = await fixture(async () => {
      calls++;
      entered();
      await gate;
      return json({ data: [{ id: "chosen-model" }] });
    });
    const input: ModelUpdate = { expectedVersion: 0, provider: "openai", model: "chosen-model", apiKey: KEY };
    const first = f.service.saveModel(DID, input, "pending-save-0001");
    await started;
    await expect(f.service.saveModel(DID, input, "pending-save-0001")).rejects.toMatchObject({ status: 409 });
    const other = f.service.onboarding(DID, { expectedVersion: 0, action: "skip" }, "onboard-save-0002");
    expect((await other).version).toBe(1);
    release();
    await expect(first).rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(1);
    expect(await f.service.settings(DID)).toMatchObject({
      version: 1,
      onboarding: { status: "skipped" },
      model: { provider: "none" },
    });
  });

  test("repository identity owns its workspace and tokens cannot follow a changed remote or owner", async () => {
    const f = await fixture();
    const url = "https://forge.example/team/one.git";
    const first = await f.service.saveRepository(
      DID,
      { expectedVersion: 0, url, branch: "refs/heads/main", token: KEY },
      "repo-first-0001",
    );
    expect(first.workspaceId).toBe(workspaceId(DID, url, "main"));
    expect(f.connections[0]!.input).toEqual({ url, branch: "main", token: KEY });
    expect(f.connections[0]!.directory).toEndWith(first.workspaceId);
    expect(JSON.stringify(first)).not.toContain(KEY);
    expect(await f.box.open((await f.store.get(DID))!.repoToken!)).toBe(KEY);
    const second = await f.service.saveRepository(
      DID,
      { expectedVersion: 1, url, branch: "release" },
      "repo-second-0002",
    );
    expect(f.connections[1]!.input.token).toBe(KEY);
    expect(second.workspaceId).not.toBe(first.workspaceId);
    await f.service.saveRepository(
      DID,
      { expectedVersion: 2, url: "https://forge.example/team/two.git", branch: "main" },
      "repo-third-0003",
    );
    expect(f.connections[2]!.input.token).toBeUndefined();
    expect((await f.store.get(DID))!.repoToken).toBeUndefined();
    const bob = await f.service.saveRepository(OTHER, { expectedVersion: 0, url, branch: "main" }, "repo-first-0001");
    expect(bob.workspaceId).not.toBe(first.workspaceId);
    expect(f.connections[3]!.input.token).toBeUndefined();
    expect(f.changes).toHaveLength(4);
  });
});

test("PostHog credentials are write-only, project-bound and revoked before cached adapters can disclose data", async () => {
  const calls: string[] = [];
  const f = await fixture(async (url, init) => {
    calls.push(url);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    return json({ columns: ["id", "timestamp", "event", "exception_list", "fingerprint", "level", "session_id", "steps"],
      results: [], is_cached: false, last_refresh: new Date().toISOString() });
  });
  const workspace = workspaceId(DID);
  const input = { expectedVersion: 0, workspaceId: workspace, enabled: true, origin: "https://us.posthog.com", projectId: "42",
    includeRecordings: false, apiKey: KEY };
  const saved = await f.service.saveTelemetry(DID, input, "posthog-first-001");
  expect(saved.telemetry).toMatchObject({ status: "verified", keyConfigured: true, projectId: "42" });
  expect(JSON.stringify(saved)).not.toContain(KEY);
  expect(await f.box.open((await f.store.get(DID))!.telemetryKey!)).toBe(KEY);
  expect(await f.service.saveTelemetry(DID, input, "posthog-first-001")).toEqual(saved);
  expect(calls.length).toBe(1);
  const adapter = (await f.service.telemetryFor(DID, workspace))!;
  expect((await adapter.exceptions()).events).toEqual([]);
  const { apiKey: _secret, ...withoutKey } = input;
  await expect(f.service.saveTelemetry(DID, { ...withoutKey, expectedVersion: 1, projectId: "99" },
    "posthog-other-project")).rejects.toThrow("API key");
  await f.service.saveTelemetry(DID, { ...withoutKey, expectedVersion: 1, enabled: false }, "posthog-disconnect");
  await expect(adapter.exceptions()).rejects.toThrow();
  expect(await f.service.telemetryFor(DID, workspace)).toBeNull();
  expect((await f.store.get(DID))!.telemetryKey).toBeUndefined();
  expect(await f.service.telemetryFor(OTHER, workspace)).toBeNull();
});

test("contact routing defaults to the owner inbox; external recipients require an authenticated bridge", async () => {
  const f = await fixture();
  const initial = await f.service.settings(DID);
  expect(initial.people).toMatchObject({ enabled: true, contacts: [{ id: "workspace-owner", did: DID }] });
  const contact = { id: "support", alias: "Customer support", roles: ["user" as const], areas: ["checkout"] };
  const input = { expectedVersion: 0, workspaceId: initial.workspaceId, enabled: true, contacts: [contact] };
  await expect(f.service.savePeople(DID, input, "contact-no-bridge")).rejects.toThrow("delivery bridge");
  const saved = await f.service.savePeople(DID, { ...input, webhookUrl: "https://support.example/ephyra", token: KEY }, "contact-bridge-01");
  expect(saved.people).toMatchObject({ contacts: [contact], keyConfigured: true });
  expect(JSON.stringify(saved)).not.toContain(KEY);
  expect((await f.service.peopleFor(DID, saved.workspaceId))!.token).toBe(KEY);
  expect(await f.service.peopleFor(OTHER, saved.workspaceId)).toBeNull();
  await expect(f.service.savePeople(DID, { ...input, expectedVersion: 1, webhookUrl: "http://localhost/messages", token: KEY },
    "contact-private-01")).rejects.toThrow();
  await f.service.savePeople(DID, { ...input, expectedVersion: 1, enabled: false }, "contact-disable-01");
  expect(await f.service.peopleFor(DID, saved.workspaceId)).toBeNull();
});

test("canonical native identity determines the workspace and changing repositories clears scoped connections", async () => {
  const f = await fixture();
  const seen: RepositoryInput[] = [];
  const canonical = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
  const service = new Accounts({ ...f.service.options, repository: {
    resolve: async (input) => ({ url: canonical, forge: { kind: "radicle", source: input.url, repositoryId: canonical } }),
    discover: async () => "trunk",
    prepare: async (input) => { seen.push(input); return { url: input.url, branch: input.branch, head: "a".repeat(40), verifiedAt: "now" }; },
  } });
  const initial = await service.settings(DID);
  await service.savePeople(DID, { expectedVersion: 0, workspaceId: initial.workspaceId, enabled: true,
    contacts: initial.people!.contacts }, "owner-setup-0001");
  const saved = await service.saveRepository(DID, { expectedVersion: 1, url: "https://app.radicle.xyz/example", branch: "main",
    discoverDefaultBranch: true }, "native-first-001");
  expect(saved.workspaceId).toBe(workspaceId(DID, canonical, "trunk"));
  expect(saved.repository?.forge).toMatchObject({ kind: "radicle", source: "https://app.radicle.xyz/example" });
  expect(seen[0]?.url).toBe(canonical);
  expect(saved.people?.workspaceId).toBe(saved.workspaceId);
  const other = await f.service.saveRepository(DID, { expectedVersion: 2, url: "https://forge.example/new.git", branch: "main" },
    "different-repo-001");
  expect((await f.store.get(DID))!.settings.people).toBeUndefined();
  expect(other.people?.contacts).toEqual(initial.people!.contacts);
});
