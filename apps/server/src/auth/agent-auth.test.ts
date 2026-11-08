import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { convexTest } from "convex-test";
import { MemoryAgentStore, ConvexAgentStore, type AgentBinding, type AgentStore } from "./agent-store.ts";
import { createAgentAccess, ASSERTION_GRANT, CLAIM_GRANT } from "./agent-service.ts";
import { agentAuthRoutes } from "./agent-routes.ts";
import { sessionCookieName } from "./browser-session.ts";
import schema from "../../convex/schema.ts";

const origin = "https://console.ephyra.test";
const did = "did:plc:alice";
const other = "did:plc:bob";
const session = "h".repeat(43);
const otherSession = "b".repeat(43);
const repository = { url: "https://github.com/alice/project", branch: "main" };
const repositoryRevision = "2026-11-08T11:59:00.000Z";
const secret = "s".repeat(40);
const modules = {
  "./_generated/server.js": () => import("../../convex/_generated/server.js"),
  "./_generated/api.js": () => import("../../convex/_generated/api.js"),
  "./agent_auth.ts": () => import("../../convex/agent_auth.ts"),
};
let priorSecret: string | undefined;
beforeEach(() => { priorSecret = process.env.EPHYRA_CONVEX_SECRET; process.env.EPHYRA_CONVEX_SECRET = secret; });
afterEach(() => {
  if (priorSecret === undefined) delete process.env.EPHYRA_CONVEX_SECRET;
  else process.env.EPHYRA_CONVEX_SECRET = priorSecret;
});
const backends: { name: string; create: () => AgentStore }[] = [
  { name: "memory", create: () => new MemoryAgentStore() },
  { name: "Convex", create: () => {
    const t = convexTest(schema, modules);
    const client = new ConvexHttpClient("https://test.convex.cloud");
    Object.defineProperties(client, { query: { value: t.query.bind(t) }, mutation: { value: t.mutation.bind(t) } });
    return new ConvexAgentStore(client, secret);
  } },
];

function fixture(store: AgentStore) {
  let now = Date.parse("2026-11-08T12:00:00Z");
  let binding: AgentBinding | null = null;
  let calls = 0;
  let resolver: (() => Promise<void>) | undefined;
  const service = createAgentAccess({ store, origin, signingSecret: Buffer.alloc(32, 3).toString("base64"),
    now: () => now,
    signIn: { authenticate: async (token) => token === session ? { did, handle: "alice.test" }
      : token === otherSession ? { did: other } : null },
    currentBinding: async () => binding,
    resolveBinding: async (ownerDid, repo) => {
      calls++;
      if (resolver) await resolver();
      binding = { ownerDid, workspaceId: "workspace-alice", repository: repo, repositoryRevision };
      return binding;
    },
  });
  const app = agentAuthRoutes(service);
  const json = (path: string, body: unknown) => app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const form = (path: string, values: Record<string, string>, extra: Record<string, string> = {}) => app.request(path, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...extra },
    body: new URLSearchParams(values),
  });
  const register = async (scopes?: string[]) => {
    const response = await json("/agent/identity", { type: "anonymous", intended_owner: did, repository, ...(scopes ? { scopes } : {}) });
    expect(response.status).toBe(201);
    return response.json() as Promise<{ registration_id: string; claim_token: string; identity_assertion: string }>;
  };
  const begin = async (claimToken: string) => {
    const response = await json("/agent/identity/claim", { claim_token: claimToken, intended_owner: did });
    expect(response.status).toBe(200);
    const value = await response.json() as { claim_attempt: { verification_uri: string; user_code: string } };
    return { ...value.claim_attempt, attempt: new URL(value.claim_attempt.verification_uri).searchParams.get("attempt")! };
  };
  const csrf = async (uri: string, browser = session) => {
    const response = await app.request(uri, { headers: { Cookie: `${sessionCookieName(origin)}=${browser}` } });
    const html = await response.text();
    return { response, html, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "" };
  };
  const approve = async (attempt: { attempt: string; user_code: string; verification_uri: string },
    options: { browser?: string; code?: string; csrf?: string; requestOrigin?: string } = {}) => {
    const browser = options.browser ?? session;
    const proof = options.csrf ?? (await csrf(attempt.verification_uri, browser)).csrf;
    return form("/agent/claim", { attempt: attempt.attempt, code: options.code ?? attempt.user_code, csrf: proof },
      { Cookie: `${sessionCookieName(origin)}=${browser}`, Origin: options.requestOrigin ?? origin });
  };
  const poll = (claimToken: string) => form("/oauth2/token", { grant_type: CLAIM_GRANT, claim_token: claimToken, resource: service.resource });
  const claim = async (scopes?: string[]) => {
    const registered = await register(scopes);
    const attempt = await begin(registered.claim_token);
    expect((await approve(attempt)).status).toBe(200);
    const response = await poll(registered.claim_token);
    expect(response.status).toBe(200);
    const token = await response.json() as { access_token: string; identity_assertion: string; scope: string };
    return { registered, attempt, token };
  };
  return { service, app, store, json, form, register, begin, csrf, approve, poll, claim,
    advance: (ms: number) => { now += ms; }, calls: () => calls,
    binding: (next: AgentBinding | null) => { binding = next; }, resolver: (next: () => Promise<void>) => { resolver = next; } };
}

for (const backend of backends) describe(`${backend.name} scoped agent claims`, () => {
  test("one claim cannot reset setup costs by selecting new operation keys", async () => {
    const f = fixture(backend.create());
    const { token } = await f.claim(["bootstrap:read", "bootstrap:run"]);
    expect(await f.service.setupOperation(token.access_token, "agent-baseline-one")).toBe("agent-baseline-one");
    expect(await f.service.setupOperation(token.access_token, "agent-baseline-one")).toBe("agent-baseline-one");
    await expect(f.service.setupOperation(token.access_token, "agent-baseline-two")).rejects.toMatchObject({ status: 409 });
    const outcomes = await Promise.allSettled(["agent-baseline-one", "agent-baseline-three"]
      .map(key => f.service.setupOperation(token.access_token, key)));
    expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "rejected"]);
    await f.service.revoke(token.access_token);
    await expect(f.service.setupOperation(token.access_token, "agent-baseline-one")).rejects.toMatchObject({ status: 401 });
  });

  test("owner history lists the newest 100 registrations without including another owner's grants", async () => {
    const store = backend.create();
    for (let index = 0; index < 102; index++) {
      const ownerDid = index === 101 ? other : did;
      await store.create({ id: `listing-${index}`, revision: 0, version: 1, intendedOwner: ownerDid,
        repository, scopes: ["bootstrap:read"], claimHash: `listing-claim-${index}`, claimExpiresMs: index,
        createdMs: index, expiresMs: index, ...(index === 100 ? { revokedMs: index } : {}),
        binding: { ownerDid, workspaceId: `workspace-${ownerDid}`, repository, repositoryRevision } });
    }
    const records = await store.list(did);
    expect(records).toHaveLength(100);
    expect(records[0]!.id).toBe("listing-100");
    expect(records.at(-1)!.id).toBe("listing-1");
    expect(records[0]!.revokedMs).toBe(100);
    expect(records.every((record) => record.binding?.ownerDid === did)).toBe(true);
    expect((await store.list(other)).map((record) => record.id)).toEqual(["listing-101"]);
  });

  test("discovery advertises the DID profile only and a real claim grants scoped, revocable bootstrap authority", async () => {
    const f = fixture(backend.create());
    const metadata = await (await f.app.request("/.well-known/oauth-authorization-server")).json();
    expect(metadata.agent_auth.identity_types_supported).toEqual(["anonymous"]);
    expect(metadata.agent_auth.claim_binding).toBe("ephyra:notorganic-did-v1");
    expect(metadata.agent_auth.events_endpoint).toBeUndefined();
    const { registered, attempt, token } = await f.claim(["bootstrap:read", "bootstrap:context", "bootstrap:run"]);
    expect(attempt.verification_uri).not.toContain(attempt.user_code);
    expect(token.scope).toBe("bootstrap:read bootstrap:context bootstrap:run");
    expect(await f.service.authenticate(token.access_token, "bootstrap:run")).toEqual({ ownerDid: did,
      workspaceId: "workspace-alice", repository, repositoryRevision, registrationId: registered.registration_id,
      scopes: ["bootstrap:read", "bootstrap:context", "bootstrap:run"] });
    expect(await f.service.signIn.authenticate(token.access_token)).toBeNull();
    const listing = await f.service.list(did);
    expect(listing).toHaveLength(1);
    expect(JSON.stringify(listing)).not.toContain(registered.claim_token);
    expect(JSON.stringify(listing)).not.toContain(token.access_token);
    expect(await f.service.list(other)).toEqual([]);
    const renewed = await f.form("/oauth2/token", { grant_type: ASSERTION_GRANT,
      assertion: token.identity_assertion, resource: f.service.resource });
    expect(renewed.status).toBe(200);
    expect((await f.form("/oauth2/revoke", { token: token.access_token })).status).toBe(200);
    expect(await f.service.authenticate(token.access_token)).toBeNull();
    expect((await f.form("/oauth2/token", { grant_type: ASSERTION_GRANT, assertion: token.identity_assertion })).status).toBe(400);
  });

  test("preclaim credentials have no private capability and old assertions cannot survive or revoke a claimed registration", async () => {
    const f = fixture(backend.create());
    const registered = await f.register(["bootstrap:read"]);
    const preResponse = await f.form("/oauth2/token", { grant_type: ASSERTION_GRANT, assertion: registered.identity_assertion });
    expect(preResponse.status).toBe(200);
    const pre = await preResponse.json();
    expect(pre.scope).toBe("");
    expect(await f.service.authenticate(pre.access_token)).toBeNull();
    const attempt = await f.begin(registered.claim_token);
    expect((await f.approve(attempt)).status).toBe(200);
    const result = await (await f.poll(registered.claim_token)).json();
    expect((await f.form("/oauth2/token", { grant_type: ASSERTION_GRANT, assertion: registered.identity_assertion })).status).toBe(400);
    await f.service.revoke(registered.identity_assertion);
    await f.service.revoke(pre.access_token);
    expect(await f.service.authenticate(result.access_token, "bootstrap:read")).not.toBeNull();
    expect(await f.service.authenticate(result.access_token, "bootstrap:run")).toBeNull();
  });

  test("the intended DID, code, browser session and exact Origin are all required before repository connection", async () => {
    const f = fixture(backend.create());
    const registered = await f.register();
    expect((await f.json("/agent/identity/claim", { claim_token: registered.claim_token, intended_owner: other })).status).toBe(403);
    const attempt = await f.begin(registered.claim_token);
    expect((await f.approve(attempt, { browser: otherSession })).status).toBe(403);
    expect((await f.approve(attempt, { requestOrigin: "https://evil.ephyra.test" })).status).toBe(403);
    expect((await f.approve(attempt, { csrf: "forged" })).status).toBe(403);
    expect((await f.approve(attempt, { code: "not-a-code" })).status).toBe(403);
    expect(f.calls()).toBe(0);
    const anonymous = await f.app.request(attempt.verification_uri);
    expect(await anonymous.text()).toContain("Sign in with Not Organic");
    expect(anonymous.headers.get("referrer-policy")).toBe("no-referrer");
    expect(anonymous.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await f.approve(attempt)).status).toBe(200);
    expect(f.calls()).toBe(1);
  });

  test("five wrong codes remain locked across fresh claim attempts", async () => {
    const f = fixture(backend.create());
    const registered = await f.register();
    let attempt = await f.begin(registered.claim_token);
    for (let i = 0; i < 5; i++) {
      const code = attempt.user_code === "000000" ? "111111" : "000000";
      expect((await f.approve(attempt, { code })).status).toBe(403);
      if (i < 4) attempt = await f.begin(registered.claim_token);
    }
    expect((await f.app.request(attempt.verification_uri)).status).toBe(410);
    expect((await f.approve(attempt)).status).not.toBe(200);
    expect((await f.json("/agent/identity/claim", { claim_token: registered.claim_token, intended_owner: did })).status).toBe(403);
    expect(f.calls()).toBe(0);
  });

  test("polling honors its durable interval, expires the attempt and never returns a credential while pending", async () => {
    const f = fixture(backend.create());
    const registered = await f.register();
    const attempt = await f.begin(registered.claim_token);
    expect(await (await f.poll(registered.claim_token)).json()).toMatchObject({ error: "authorization_pending", interval: 5 });
    expect(await (await f.poll(registered.claim_token)).json()).toMatchObject({ error: "slow_down", interval: 10 });
    f.advance(10_000);
    expect(await (await f.poll(registered.claim_token)).json()).toMatchObject({ error: "authorization_pending" });
    f.advance(10 * 60_000);
    expect(await (await f.poll(registered.claim_token)).json()).toMatchObject({ error: "expired_token" });
    expect((await f.app.request(attempt.verification_uri)).status).toBe(410);
    expect((await f.approve(attempt)).status).not.toBe(200);
    await f.begin(registered.claim_token);
    f.advance(30 * 60_000);
    expect((await f.poll(registered.claim_token)).status).toBe(410);
  });

  test("workspace changes and expiry invalidate tokens, with no fallback to the owner's next repository", async () => {
    const f = fixture(backend.create());
    const { token } = await f.claim();
    f.binding({ ownerDid: did, workspaceId: "new-workspace", repository, repositoryRevision });
    expect(await f.service.authenticate(token.access_token)).toBeNull();
    expect((await f.form("/oauth2/token", { grant_type: ASSERTION_GRANT, assertion: token.identity_assertion })).status).toBe(400);
    f.binding({ ownerDid: did, workspaceId: "workspace-alice", repository, repositoryRevision });
    f.advance(5 * 60_000 + 1);
    expect(await f.service.authenticate(token.access_token)).toBeNull();
    f.advance(24 * 3600_000);
    expect((await f.form("/oauth2/token", { grant_type: ASSERTION_GRANT, assertion: token.identity_assertion })).status).toBe(400);
  });

  test("reconnecting the same repository never revives the previous connection's grant", async () => {
    const f = fixture(backend.create());
    const { token } = await f.claim();
    f.binding({ ownerDid: did, workspaceId: "workspace-alice", repository,
      repositoryRevision: "2026-11-08T12:01:00.000Z" });
    expect(await f.service.authenticate(token.access_token)).toBeNull();
    expect((await f.form("/oauth2/token", { grant_type: ASSERTION_GRANT, assertion: token.identity_assertion })).status).toBe(400);
  });

  test("assertions are verified, audience bound, and revocation is restricted to the owner", async () => {
    const f = fixture(backend.create());
    const { registered, token } = await f.claim();
    const parts = token.identity_assertion.split(".");
    parts[2] = `${parts[2]![0] === "a" ? "b" : "a"}${parts[2]!.slice(1)}`;
    expect((await f.form("/oauth2/token", { grant_type: ASSERTION_GRANT, assertion: parts.join(".") })).status).toBe(400);
    expect((await f.form("/oauth2/token", { grant_type: ASSERTION_GRANT,
      assertion: token.identity_assertion, resource: "https://elsewhere.test/" })).status).toBe(400);
    expect(await f.service.revokeOwned(other, registered.registration_id)).toBe(false);
    expect(await f.service.authenticate(token.access_token)).not.toBeNull();
    expect(await f.service.revokeOwned(did, registered.registration_id)).toBe(true);
    expect(await f.service.authenticate(token.access_token)).toBeNull();
  });

  test("an ambiguous repository connection is reconciled from saved binding without retrying the side effect", async () => {
    const f = fixture(backend.create());
    const registered = await f.register();
    const attempt = await f.begin(registered.claim_token);
    f.resolver(async () => {
      f.binding({ ownerDid: did, workspaceId: "workspace-alice", repository, repositoryRevision });
      throw new Error("sensitive upstream response");
    });
    const uncertain = await f.approve(attempt);
    expect(uncertain.status).toBe(409);
    expect(await uncertain.text()).not.toContain("sensitive");
    expect((await f.approve(attempt)).status).toBe(200);
    expect(f.calls()).toBe(1);
    expect((await f.poll(registered.claim_token)).status).toBe(200);
  });

  test("concurrent approvals have one repository callback owner", async () => {
    const f = fixture(backend.create());
    const registered = await f.register();
    const attempt = await f.begin(registered.claim_token);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.resolver(async () => { entered(); await gate; });
    const first = f.approve(attempt);
    await started;
    const second = await f.approve(attempt);
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(f.calls()).toBe(1);
    expect((await f.poll(registered.claim_token)).status).toBe(200);
  });

  test("unsafe registration cannot request secrets, unrelated scope or credential-bearing repositories", async () => {
    const f = fixture(backend.create());
    for (const patch of [
      { type: "service_auth" }, { scopes: ["human:approve"] },
      { scopes: ["bootstrap:context"] }, { scopes: ["bootstrap:run"] },
      { repository: { ...repository, url: "https://user:secret@github.com/alice/project" } },
      { repository: { ...repository, url: `${repository.url}?token=secret` } },
      { repository: { ...repository, url: "http://github.com/alice/project" } },
      { repository: { ...repository, branch: "main:refs/heads/other" } },
    ]) {
      const response = await f.json("/agent/identity", { type: "anonymous", intended_owner: did, repository, ...patch });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("token=secret");
    }
  });
});
