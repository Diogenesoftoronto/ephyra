import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountSettings, Draft, PolicyActivationReceipt, TeamInviteResult, TeamState, WorkspaceAccess } from "@ephyra/core";
import { AUTONOMY_TEMPLATE } from "@ephyra/policy";
import { composeApplication } from "./application";
import { readConfig } from "./config";
import { fakeNotOrganic } from "./auth/notorganic.fixture";
import { sessionCookieName } from "./auth/browser-session";
import { MemoryAccountStore } from "./setup/account-store";
import { sha256 } from "./docs";

const ALICE = "did:plc:alice", BOB = "did:plc:bob", CAROL = "did:plc:carol";
const ORIGIN = "https://ephyra.example", SERVICE = "s".repeat(32);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ephyra-team-http-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const identity = { approved: true, product: "ephyra", did: ALICE };
  const issuer = fakeNotOrganic(identity);
  const store = new MemoryAccountStore();
  const providerCalls: string[] = [];
  const server = await composeApplication(readConfig({
    EPHYRA_API_TOKEN: SERVICE, EPHYRA_DATA_DIR: root, EPHYRA_PUBLIC_ORIGIN: ORIGIN,
    EPHYRA_SESSION_KEY: Buffer.alloc(32, 9).toString("base64"), EPHYRA_APPROVER_DIDS: ALICE,
    NOTORGANIC_ISSUER: "https://api.notorganic.test", NOTORGANIC_AUTHORIZATION_URL: "https://id.notorganic.test/authorize",
    NOTORGANIC_PRODUCT: "ephyra", EPHYRA_DRAFT: "fake",
  }), {
    startJobs: false, accountStore: store, notOrganicFetch: issuer.fetcher,
    providerFetch: async (url) => {
      providerCalls.push(url);
      return Response.json(url.endsWith("/models") ? { data: [{ id: "team-model" }] } : {
        model: "returned-team-model", choices: [{ message: { content: JSON.stringify({ text: "Recorded test answer." }) } }], usage: { total_tokens: 7 },
      });
    },
  });
  cleanup.push(() => server.close());
  const cookies = new Map<string, string>();
  for (const did of [ALICE, BOB, CAROL]) {
    identity.did = did;
    const start = await server.app.request("/auth/login");
    const cookie = start.headers.getSetCookie().find((value) => value.startsWith("ephyra_login="))!.split(";")[0]!;
    const callback = new URL(issuer.approve(start.headers.get("location")!));
    const finish = await server.app.request(`${callback.pathname}${callback.search}`, { headers: { cookie } });
    expect(finish.status).toBe(303);
    const session = finish.headers.getSetCookie().find((value) => value.startsWith(`${sessionCookieName(ORIGIN)}=`))!;
    cookies.set(did, session.split(";")[0]!);
  }
  const request = (did: string, path: string, options: {
    method?: string; body?: unknown; workspace?: string; key?: string; headers?: Record<string, string>;
  } = {}) =>
    server.app.request(path, { method: options.method ?? "GET", headers: {
      cookie: cookies.get(did)!, Origin: ORIGIN, "X-Ephyra-Account": did, "content-type": "application/json",
      "Idempotency-Key": options.key ?? crypto.randomUUID(),
      ...(options.workspace ? { "X-Ephyra-Workspace": options.workspace } : {}), ...options.headers,
    }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const settings = async (did: string) => AccountSettings.parse(await (await request(did, "/v1/account")).json());
  const invite = async (did: string, role: "viewer" | "approver") => {
    const current = await settings(ALICE);
    const input = { expectedVersion: current.version, workspaceId: current.workspaceId, label: did, role };
    const response = await request(ALICE, "/v1/account/team/invitations", { method: "POST", workspace: current.workspaceId, body: input });
    expect(response.status).toBe(200);
    const created = TeamInviteResult.parse(await response.json());
    const preview = await request(did, "/v1/account/team/preview", { method: "POST", body: { token: created.token } });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ workspace: { ownerDid: ALICE, workspaceId: current.workspaceId, role } });
    expect((await settings(ALICE)).version).toBe(current.version + 1); // Preview cannot accept or mutate.
    const accepted = await request(did, "/v1/account/team/accept", { method: "POST", body: { token: created.token } });
    expect(accepted.status).toBe(200);
    expect(WorkspaceAccess.parse(await accepted.json())).toMatchObject({ role, ownerDid: ALICE });
    return created;
  };
  return { server, store, request, settings, invite, cookies, providerCalls };
}

describe("signed-in shared workspace authority", () => {
  test("Viewer sees recorded owner content but cannot approve, edit, spend, run setup or impersonate the owner", async () => {
    const f = await fixture();
    const invitation = await f.invite(BOB, "viewer");
    const workspace = invitation.team.workspaceId;
    const draftResponse = await f.request(ALICE, "/v1/drafts", { method: "POST", workspace, body: { path: "autonomy.md" } });
    expect(draftResponse.status).toBe(200);
    const draft = Draft.parse(await draftResponse.json());
    const shared = await f.request(BOB, "/v1/drafts", { workspace });
    expect(shared.status).toBe(200);
    expect((await shared.json() as Draft[]).map((item) => item.id)).toContain(draft.id);
    expect(await (await f.request(BOB, "/v1/drafts")).json()).toEqual([]);
    expect(await (await f.request(BOB, "/v1/me", { workspace })).json()).toMatchObject({ principal: BOB, approver: false });
    const workspaces = await (await f.request(BOB, "/v1/account/workspaces")).json() as WorkspaceAccess[];
    expect(workspaces.map((item) => item.role)).toEqual(["owner", "viewer"]);
    for (const [path, method, body] of [
      ["/v1/drafts", "POST", { path: "autonomy.md" }],
      [`/v1/drafts/${draft.id}/messages`, "POST", { text: "Spend on a reply." }],
      [`/v1/drafts/${draft.id}/content`, "PUT", { content: AUTONOMY_TEMPLATE, baseDigest: draft.baseDigest }],
      [`/v1/drafts/${draft.id}/publish`, "POST", {}],
      [`/v1/drafts/${draft.id}/activate`, "POST", {}],
      ["/v1/trails/missing/decide", "POST", { checkpoint: "A", verdict: "approve" }],
      ["/v1/spend/missing/decide", "POST", { verdict: "approve" }],
      ["/v1/setup", "POST", {}],
    ] as const) {
      const response = await f.request(BOB, path, { method, body, workspace, headers: { "X-Ephyra-Principal": ALICE } });
      expect(response.status).toBe(403);
    }
    const owner = await f.settings(ALICE);
    expect((await f.request(BOB, "/v1/account/model", { method: "PUT", workspace, headers: { "X-Ephyra-Account": ALICE },
      body: { expectedVersion: owner.version, provider: "none", model: "" } })).status).toBe(409);
    expect((await f.request(BOB, "/v1/account/team", { workspace })).status).toBe(409);
    expect((await f.request(BOB, "/v1/account/team/revoke", { method: "POST", workspace,
      body: { expectedVersion: owner.version, workspaceId: workspace, id: invitation.invitationId } })).status).toBe(409);
    expect((await f.request(BOB, "/v1/account/team/invitations", { method: "POST", workspace,
      body: { expectedVersion: owner.version, workspaceId: workspace, label: "Escalation", role: "approver" } })).status).toBe(409);
    expect(f.providerCalls).toEqual([]);
    expect((await f.settings(ALICE)).version).toBe(owner.version);
  });

  test("Approver can draft, publish and activate the owner's policy, then loses access immediately on revoke", async () => {
    const f = await fixture();
    const invitation = await f.invite(CAROL, "approver");
    const workspace = invitation.team.workspaceId;
    const owner = await f.settings(ALICE);
    expect((await f.request(ALICE, "/v1/account/model", { method: "PUT", workspace, body: {
      expectedVersion: owner.version, provider: "compatible", model: "team-model", baseUrl: "https://models.example/v1", apiKey: "private-owner-model-key",
    } })).status).toBe(200);
    expect(await (await f.request(CAROL, "/v1/me", { workspace })).json()).toMatchObject({ principal: CAROL, approver: true });
    const created = await f.request(CAROL, "/v1/drafts", { method: "POST", workspace, body: { path: "autonomy.md" } });
    expect(created.status).toBe(200);
    const draft = Draft.parse(await created.json());
    expect(draft.createdBy).toBe(CAROL);
    const answer = await f.request(CAROL, `/v1/drafts/${draft.id}/messages`, { method: "POST", workspace, body: { text: "Explain the draft." } });
    expect(answer.status).toBe(200);
    expect(f.providerCalls.filter((url) => url.endsWith("/chat/completions"))).toHaveLength(1);
    expect((await f.request(CAROL, `/v1/drafts/${draft.id}/content`, { method: "PUT", workspace,
      body: { content: AUTONOMY_TEMPLATE, baseDigest: draft.baseDigest } })).status).toBe(200);
    const published = await f.request(CAROL, `/v1/drafts/${draft.id}/publish`, { method: "POST", workspace, body: {} });
    expect(published.status).toBe(200);
    const saved = Draft.parse(await published.json());
    expect(saved.published?.by).toBe(CAROL);
    const activation = { expectedCommit: saved.published!.commit, expectedDigest: sha256(saved.content), expectedActive: null };
    const activated = await f.request(CAROL, `/v1/drafts/${draft.id}/activate`, { method: "POST", workspace, body: activation });
    expect(activated.status).toBe(200);
    const receipt = PolicyActivationReceipt.parse(await activated.json());
    expect(receipt.sourceCommit).toBe(saved.published!.commit);
    expect(await (await f.request(ALICE, "/v1/policy/active", { workspace })).json()).toEqual(receipt);
    expect((await f.request(CAROL, "/v1/setup", { method: "POST", workspace, body: {} })).status).toBe(403);
    const current = await f.settings(ALICE);
    const removed = await f.request(ALICE, "/v1/account/team/revoke", { method: "POST", workspace,
      body: { expectedVersion: current.version, workspaceId: workspace, id: invitation.invitationId } });
    expect(removed.status).toBe(200);
    for (const path of ["/v1/me", "/v1/drafts", `/v1/drafts/${draft.id}`]) expect((await f.request(CAROL, path, { workspace })).status).toBe(409);
    expect((await f.request(CAROL, "/v1/drafts", { method: "POST", workspace, body: { path: "autonomy.md" } })).status).toBe(409);
    expect((await f.request(CAROL, `/v1/drafts/${draft.id}/activate`, { method: "POST", workspace, body: activation })).status).toBe(409);
    expect((await (await f.request(CAROL, "/v1/account/workspaces")).json() as WorkspaceAccess[]).map((item) => item.role)).toEqual(["owner"]);
    // Reinviting as Viewer cannot inherit the old cached runtime's Approver permission.
    await f.invite(CAROL, "viewer");
    expect(await (await f.request(CAROL, "/v1/me", { workspace })).json()).toMatchObject({ approver: false });
    expect((await f.request(CAROL, `/v1/drafts/${draft.id}/publish`, { method: "POST", workspace, body: {} })).status).toBe(403);
    expect((await f.request(CAROL, `/v1/drafts/${draft.id}/activate`, { method: "POST", workspace, body: activation })).status).toBe(403);
  });

  test("team endpoints require a human, exact account/workspace binding, Origin and version; errors never reflect a token", async () => {
    const f = await fixture();
    const owner = await f.settings(ALICE);
    const input = { expectedVersion: owner.version, workspaceId: owner.workspaceId, label: "Teammate", role: "viewer" };
    expect((await f.server.app.request("/v1/account/team")).status).toBe(401);
    expect((await f.server.app.request("/v1/account/team", { headers: { Authorization: `Bearer ${SERVICE}`, "X-Ephyra-Principal": ALICE } })).status).toBe(403);
    const badHeaders: Record<string, string>[] = [{ Origin: "https://other.example" }, { "X-Ephyra-Account": BOB }, { "X-Ephyra-Workspace": "wrong" }];
    for (const headers of badHeaders) {
      const response = await f.request(ALICE, "/v1/account/team/invitations", { method: "POST", workspace: owner.workspaceId, body: input, headers });
      expect([403, 409]).toContain(response.status);
    }
    const raw = "secret-value-that-must-not-be-reflected";
    const invalid = await f.request(BOB, "/v1/account/team/accept", { method: "POST", body: { token: raw } });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(raw);
    expect(TeamState.parse(await (await f.request(ALICE, "/v1/account/team")).json()).invitations).toEqual([]);
  });
});

describe("profiles from the Not Organic authority", () => {
  test("own profile works in a shared viewer workspace; people are limited to the workspace's relations", async () => {
    const f = await fixture();
    const invitation = await f.invite(BOB, "viewer");
    const workspace = invitation.team.workspaceId;
    const own = await f.request(BOB, "/v1/profile", { workspace });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ did: BOB, status: "verified", handle: "approver.test", manageUrl: "https://id.notorganic.test/?view=profile" });
    const shared = await (await f.request(BOB, "/v1/profiles", { workspace })).json() as { people: { did: string }[] };
    expect(shared.people.map((p) => p.did).sort()).toEqual([ALICE, BOB].sort());
    const team = await (await f.request(ALICE, "/v1/profiles", { workspace })).json() as { people: { did: string; status: string }[] };
    expect(team.people.map((p) => p.did).sort()).toEqual([ALICE, BOB].sort());
    expect((await f.request(CAROL, "/v1/profiles", { workspace })).status).toBe(409);
    expect((await f.request(CAROL, `/v1/profiles/${encodeURIComponent(ALICE)}/avatar`)).status).toBe(404);
    // The fixture authority publishes no avatar, so even a permitted request has nothing to proxy.
    expect((await f.request(BOB, `/v1/profiles/${encodeURIComponent(ALICE)}/avatar`)).status).toBe(404);
  });
});
