import { expect, test } from "bun:test";
import { Unverified } from "@ephyra/core";
import { SecretBox, type Fetch } from "../auth/crypto.ts";
import { NotOrganicSignIn } from "../auth/notorganic.ts";
import { MemoryAuthStore } from "../auth/store.ts";
import { fakeNotOrganic } from "../auth/notorganic.fixture.ts";
import { MemoryAccountStore, type AccountRecord } from "./account-store.ts";
import { Accounts, initialAccount, workspaceId } from "./accounts.ts";

const did = "did:plc:deployment-owner";
const repository = "https://forge.example.com/team/application.git";
const deploymentUrl = "https://application.example.com/ephyra-deployment.json";

async function fixture(format: "sha1" | "sha256" = "sha1") {
  const head = "b".repeat(format === "sha1" ? 40 : 64);
  const workspace = workspaceId(did, repository, "release/next");
  const box = await SecretBox.fromBase64(Buffer.alloc(32, 19).toString("base64"));
  const store = new MemoryAccountStore();
  const initial = initialAccount(did);
  initial.settings.workspaceId = workspace;
  initial.settings.repository = { url: repository, branch: "refs/heads/release/next", head,
    verifiedAt: new Date().toISOString(), credentialConfigured: true };
  initial.settings.telemetry = { enabled: true, workspaceId: workspace, provider: "posthog", origin: "https://us.posthog.com",
    projectId: "42", includeRecordings: false, status: "verified", keyConfigured: true,
    checkedAt: new Date().toISOString(), detail: "Offline fixture", deploymentUrl };
  initial.repoToken = await box.seal("fixture-repository-credential");
  initial.telemetryKey = await box.seal("fixture-posthog-credential");
  await store.ensure(initial);
  const upstream = fakeNotOrganic({ approved: true, product: "ephyra", did });
  const signIn = new NotOrganicSignIn({ issuer: "https://api.notorganic.test",
    authorizationUrl: "https://id.notorganic.test/authorize", publicOrigin: "https://ephyra.example",
    product: "ephyra", scopes: [] }, new MemoryAuthStore(), box, upstream.fetcher);
  let body = JSON.stringify({ schema: 1, repository, branch: "release/next", commit: head,
    deployedAt: new Date(Date.now() - 10_000).toISOString() });
  let status = 200;
  let during: (() => Promise<void>) | undefined;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    await during?.();
    return new Response(body, { status });
  };
  const accounts = new Accounts({ store, box, signIn, dataDir: "/tmp/ephyra-deployment-offline", operationSecret: "offline-secret", fetcher });
  let mutation = 0;
  const change = async (edit: (record: AccountRecord) => void) => {
    const current = (await store.get(did))!;
    const key = `fixture-change-${++mutation}`;
    const digest = `fixture-digest-${mutation}`;
    expect((await store.begin(did, key, digest, current.settings.version)).status).toBe("fresh");
    edit(current);
    current.settings.version++;
    expect(await store.complete(did, key, digest, current)).toBe(true);
  };
  return { accounts, store, calls, head, workspace, change,
    reply: (value: unknown, responseStatus = 200) => { body = JSON.stringify(value); status = responseStatus; },
    raw: (value: string) => { body = value; },
    during: (callback: () => Promise<void>) => { during = callback; } };
}

for (const format of ["sha1", "sha256"] as const) {
  test(`deployment receipts bind the exact repository, branch and full ${format} commit without credentials`, async () => {
    const f = await fixture(format);
    const started = Date.now();
    const receipt = await f.accounts.deploymentFor(did, f.workspace, f.head);
    expect(receipt).toMatchObject({ sha: f.head, source: deploymentUrl });
    expect(Date.parse(receipt!.observedAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(receipt!.deployedAt)).toBeLessThan(started);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(deploymentUrl);
    expect(f.calls[0]!.init).toMatchObject({ method: "GET", redirect: "error" });
    const headers = new Headers(f.calls[0]!.init?.headers);
    expect([...headers]).toEqual([["accept", "application/json"]]);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(f.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(f.calls)).not.toContain("fixture-repository-credential");
    expect(JSON.stringify(f.calls)).not.toContain("fixture-posthog-credential");
    expect(await f.accounts.deploymentFor(did, f.workspace, "c".repeat(f.head.length))).toBeNull();
  });
}

test("malformed, substituted, oversized and future deployment claims remain Unverified", async () => {
  const f = await fixture();
  const valid = { schema: 1, repository, branch: "release/next", commit: f.head, deployedAt: new Date().toISOString() };
  for (const value of [
    null, [], {}, { ...valid, schema: 2 }, { ...valid, repository: "https://other.example.com/application.git" },
    { ...valid, branch: "main" }, { ...valid, branch: "refs/heads/release/next" }, { ...valid, commit: "HEAD" },
    { ...valid, commit: f.head.slice(0, 12) }, { ...valid, commit: f.head.toUpperCase() },
    { ...valid, deployedAt: "unknown" }, { ...valid, deployedAt: "2025-01-01" }, { ...valid, deployedAt: "11/08/2025" },
    { ...valid, deployedAt: new Date(Date.now() + 60_000).toISOString() },
    { ...valid, annotation: "🪼".repeat(5000) },
  ]) {
    f.reply(value);
    await expect(f.accounts.deploymentFor(did, f.workspace, f.head)).rejects.toBeInstanceOf(Unverified);
  }
  f.raw("{invalid JSON");
  await expect(f.accounts.deploymentFor(did, f.workspace, f.head)).rejects.toBeInstanceOf(Unverified);
  f.reply(valid, 503);
  await expect(f.accounts.deploymentFor(did, f.workspace, f.head)).rejects.toBeInstanceOf(Unverified);
});

test("missing or cross-workspace deployment authority never triggers a request", async () => {
  const f = await fixture();
  expect(await f.accounts.deploymentFor(did, "ws_other", f.head)).toBeNull();
  expect(await f.accounts.deploymentFor("did:plc:someone-else", f.workspace, f.head)).toBeNull();
  await f.change(record => { record.settings.telemetry!.enabled = false; });
  expect(await f.accounts.deploymentFor(did, f.workspace, f.head)).toBeNull();
  expect(f.calls).toHaveLength(0);
});

test("workspace, repository and connection changes during retrieval deny the captured deployment receipt", async () => {
  const mutations: ((record: AccountRecord) => void)[] = [
    record => { record.settings.workspaceId = workspaceId(did, "https://other.example.com/repo.git", "main"); },
    record => { record.settings.repository!.url = "https://other.example.com/repo.git"; },
    record => { record.settings.repository!.branch = "main"; },
    record => { record.settings.telemetry!.deploymentUrl = "https://other.example.com/deployed.json"; },
    record => { record.settings.telemetry!.enabled = false; },
  ];
  for (const mutation of mutations) {
    const f = await fixture();
    f.during(() => f.change(mutation));
    await expect(f.accounts.deploymentFor(did, f.workspace, f.head)).rejects.toMatchObject({
      name: "Unverified", feature: "deployment source authority changed",
    });
    expect(f.calls).toHaveLength(1);
  }
});
