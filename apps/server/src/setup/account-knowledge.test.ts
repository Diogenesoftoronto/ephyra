import { describe, expect, test } from "bun:test";
import { SecretBox } from "../auth/crypto.ts";
import { NotOrganicSignIn } from "../auth/notorganic.ts";
import { fakeNotOrganic } from "../auth/notorganic.fixture.ts";
import { MemoryAuthStore } from "../auth/store.ts";
import { Accounts } from "./accounts.ts";
import { MemoryAccountStore } from "./account-store.ts";

const DID = "did:plc:alice";
const BOB = "did:plc:bob";
const tool = { name: "search_notes",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } };
async function fixture() {
  let sources = [{ id: "notes", provider: "remote-mcp", label: "Project notes", resources_allowed: true, tools: [tool] }];
  let calls = 0;
  const box = await SecretBox.fromBase64(Buffer.alloc(32, 5).toString("base64"));
  const identity = { approved: true, product: "ephyra", did: DID, honorRequestedScopes: true };
  const provider = fakeNotOrganic({ ...identity, knowledge: (_path, _body, did) => {
    calls++; return Response.json({ object: "list", data: did === DID ? sources : [] });
  } });
  const signIn = new NotOrganicSignIn({
    issuer: "https://api.notorganic.test", authorizationUrl: "https://id.notorganic.test/authorize",
    publicOrigin: "https://ephyra.example", product: "ephyra", scopes: ["judgement:evaluate"],
  }, new MemoryAuthStore(), box, provider.fetcher);
  const service = new Accounts({
    store: new MemoryAccountStore(), box, operationSecret: "fixture", dataDir: "/tmp/offline-knowledge-account", signIn,
    repository: { prepare: async (input) => ({ url: input.url, branch: input.branch, head: "a".repeat(40), verifiedAt: new Date().toISOString() }) },
  });
  const login = async (scopes: string[]) => {
    const url = await signIn.begin("browser", undefined, scopes);
    return signIn.complete(new URL(provider.approve(url)).searchParams, "browser");
  };
  const enable = async () => {
    const before = await service.settings(DID);
    return service.saveKnowledge(DID, { expectedVersion: before.version, workspaceId: before.workspaceId, enabled: true, sources: [] }, crypto.randomUUID());
  };
  return { service, signIn, login, enable, setSources: (next: typeof sources) => { sources = next; }, get calls() { return calls; } };
}

describe("account-owned knowledge configuration", () => {
  test("opt-in requests knowledge scopes only for this account and hands off to its exact public-client grant", async () => {
    const f = await fixture();
    expect(await f.service.scopes(DID)).toEqual([]);
    const disabled = await f.service.knowledge(DID);
    expect(disabled.status).toBe("disabled");
    expect(f.calls).toBe(0);
    const link = new URL(disabled.manageUrl);
    expect(link.origin).toBe("https://id.notorganic.test");
    expect(link.searchParams.get("app_client")).toBe("https://ephyra.example");
    expect(link.searchParams.get("return_to")).toBe("https://ephyra.example/app/#/onboarding");
    await f.enable();
    expect((await f.service.knowledge(DID)).status).toBe("needs_sign_in");
    expect(await f.service.scopes(DID)).toEqual(["knowledge:read", "knowledge:tools"]);
    expect(await f.service.scopes(BOB)).toEqual([]);
    await f.login(await f.service.scopes(DID));
    expect((await f.service.knowledge(DID)).sources[0]?.label).toBe("Project notes");
  });
  test("saves exact approved choices idempotently, rejects revoked/changed tools, and disconnects without upstream availability", async () => {
    const f = await fixture();
    const enabled = await f.enable();
    await f.login(await f.service.scopes(DID));
    const catalog = await f.service.knowledge(DID);
    const approved = catalog.sources[0]!.tools[0]!;
    expect(approved.queryField).toBe("query");
    const selection = { id: "notes", resources: true,
      searchTool: { name: approved.name, definitionHash: approved.definitionHash, queryField: approved.queryField! } };
    const input = { expectedVersion: enabled.version, workspaceId: enabled.workspaceId, enabled: true, sources: [selection] };
    const saved = await f.service.saveKnowledge(DID, input, "save-knowledge-1");
    const calls = f.calls;
    expect(await f.service.saveKnowledge(DID, input, "save-knowledge-1")).toEqual(saved);
    expect(f.calls).toBe(calls);
    expect(await f.service.knowledgeAllowed(DID, saved.workspaceId, selection)).toBe(true);
    expect(await f.service.knowledgeAllowed(BOB, saved.workspaceId, selection)).toBe(false);
    expect(await f.service.knowledgeAllowed(DID, "another-workspace", selection)).toBe(false);
    f.setSources([{ id: "notes", provider: "remote-mcp", label: "Changed", resources_allowed: true,
      tools: [{ ...tool, annotations: { readOnlyHint: false } }] }]);
    await expect(f.service.saveKnowledge(DID, { ...input, expectedVersion: saved.version }, "changed-tool-save")).rejects.toThrow("changed");
    f.setSources([]);
    await expect(f.service.saveKnowledge(DID, { ...input, expectedVersion: saved.version }, "revoked-source-save")).rejects.toThrow("no longer shared");
    const disconnected = await f.service.saveKnowledge(DID, {
      expectedVersion: saved.version, workspaceId: saved.workspaceId, enabled: false, sources: [],
    }, "disconnect-knowledge");
    expect(disconnected.knowledge?.enabled).toBe(false);
    expect(await f.service.knowledgeAllowed(DID, saved.workspaceId, selection)).toBe(false);
    expect(await f.service.scopes(DID)).toEqual([]);
  });
  test("onboarding choices follow the first repository, while changing repositories clears workspace authority", async () => {
    const f = await fixture();
    const enabled = await f.enable();
    await f.login(await f.service.scopes(DID));
    const selected = await f.service.saveKnowledge(DID, {
      expectedVersion: enabled.version, workspaceId: enabled.workspaceId, enabled: true,
      sources: [{ id: "notes", resources: true }],
    }, "first-source-choice");
    const first = await f.service.saveRepository(DID, {
      expectedVersion: selected.version, url: "https://forge.example/one.git", branch: "main",
    }, "first-repository");
    expect(first.knowledge).toMatchObject({ enabled: true, workspaceId: first.workspaceId, sources: [{ id: "notes", resources: true }] });
    expect(await f.service.knowledgeAllowed(DID, enabled.workspaceId, { id: "notes", resources: true })).toBe(false);
    await expect(f.service.saveKnowledge(DID, {
      expectedVersion: first.version, workspaceId: enabled.workspaceId, enabled: false, sources: [],
    }, "stale-workspace-write")).rejects.toMatchObject({ status: 409 });
    const changed = await f.service.saveRepository(DID, {
      expectedVersion: first.version, url: "https://forge.example/two.git", branch: "main",
    }, "second-repository");
    expect(changed.knowledge).toBeUndefined();
    expect(await f.service.knowledgeAllowed(DID, first.workspaceId, { id: "notes", resources: true })).toBe(false);
  });
});
