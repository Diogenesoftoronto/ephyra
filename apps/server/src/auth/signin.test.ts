// Sign in with Not Organic, end to end against a fake Not Organic that enforces what the real gateway does:
// PKCE S256, an approved client origin, DPoP proofs bound to the key given at token exchange, refresh rotation.
import { AUTONOMY_TEMPLATE } from "@ephyra/policy";
import { describe, expect, test } from "bun:test";
import { b64url, sha256b64url } from "./crypto.ts";
import { compose } from "../compose.ts";
import { readConfig } from "../config.ts";
import { fakeNotOrganic } from "./notorganic.fixture.ts";
import { sessionCookieName } from "./browser-session.ts";

const ISSUER = "https://api.notorganic.test";
const AUTHORIZE = "https://id.notorganic.test/authorize";
const ORIGIN = "https://ephyra.example";
const DID = "did:plc:approver123";
const OTHER = "did:plc:someoneelse";
const SERVICE = "s".repeat(32);


async function server(fake: ReturnType<typeof fakeNotOrganic>, extra: Record<string, string> = {}) {
  const config = readConfig({
    EPHYRA_API_TOKEN: SERVICE, EPHYRA_DATA_DIR: `/tmp/ephyra-signin-${crypto.randomUUID()}`,
    EPHYRA_PUBLIC_ORIGIN: ORIGIN, EPHYRA_SESSION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    EPHYRA_APPROVER_DIDS: DID, NOTORGANIC_ISSUER: ISSUER, NOTORGANIC_AUTHORIZATION_URL: AUTHORIZE, NOTORGANIC_PRODUCT: "ephyra",
    ...extra,
  });
  return compose(config, { startJobs: false, notOrganicFetch: fake.fetcher });
}

/** Drive a browser through /auth/login → portal → /auth/callback. Returns the callback response. */
async function browserLogin(app: Awaited<ReturnType<typeof server>>["app"], fake: ReturnType<typeof fakeNotOrganic>, query = "") {
  const login = await app.request(`/auth/login${query}`);
  expect(login.status).toBe(302);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const back = new URL(fake.approve(login.headers.get("location")!));
  return app.request(`${back.pathname}${back.search}`, { headers: { cookie } });
}

describe("sign in with Not Organic", () => {
  const browserCookie = (response: Response) => response.headers.getSetCookie()
    .find((cookie) => cookie.startsWith(`${sessionCookieName(ORIGIN)}=`))!;

  test("browser sign-in returns to the app with a protected cookie and resolves the account without a pasted token", async () => {
    const fake = fakeNotOrganic({ approved: true, product: "ephyra" });
    // Drafting needs a policy, and a deployment without a repository has one only from a policy file.
    const policy = `/tmp/ephyra-signin-policy-${crypto.randomUUID()}.md`;
    await Bun.write(policy, AUTONOMY_TEMPLATE);
    const { app } = await server(fake, { EPHYRA_AUTONOMY_FILE: policy });
    const anonymous = await app.request("/auth/session");
    expect(await anonymous.json()).toEqual({ signIn: true, identity: null });
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const callback = await browserLogin(app, fake);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/app/");
    const credential = browserCookie(callback);
    expect(credential).toContain("HttpOnly");
    expect(credential).toContain("Secure");
    expect(credential).toContain("SameSite=Lax");
    expect(credential).toContain("Path=/");
    expect(credential).not.toContain("Domain=");
    const cookie = credential.split(";")[0]!;
    expect(await callback.text()).not.toContain(cookie.split("=")[1]!);
    const headers = { cookie, "X-Ephyra-Principal": OTHER };
    const identity = { principal: DID, kind: "human", approver: true };
    expect(await (await app.request("/auth/session", { headers })).json()).toEqual({ signIn: true, identity: { ...identity, alias: "approver.test" } });
    expect(await (await app.request("/v1/me", { headers })).json()).toEqual(identity);
    expect((await app.request("/v1/inbox", { headers })).status).toBe(200);
    const draft = await app.request("/v1/drafts", {
      method: "POST", headers: { ...headers, Origin: ORIGIN, "Content-Type": "application/json", "Idempotency-Key": "browser-draft" },
      body: JSON.stringify({ path: "autonomy.md" }),
    });
    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({ path: "autonomy.md", createdBy: DID });
  });

  test("cookie mutations require the exact configured Origin, while explicit bearer authentication remains usable", async () => {
    const fake = fakeNotOrganic({ approved: true, product: "ephyra" });
    const { app } = await server(fake);
    const cookie = browserCookie(await browserLogin(app, fake)).split(";")[0]!;
    for (const origin of [undefined, "null", "https://other.example", `${ORIGIN}.attacker.test`]) {
      const headers = { cookie, ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" };
      const write = await app.request("/v1/drafts", { method: "POST", headers, body: JSON.stringify({ path: "autonomy.md" }) });
      expect(write.status).toBe(403);
      expect((await app.request("/auth/logout", { method: "POST", headers })).status).toBe(403);
    }
    const token = cookie.split("=")[1]!;
    const bearer = { Authorization: `Bearer ${token}`, cookie: `${sessionCookieName(ORIGIN)}=invalid` };
    expect((await app.request("/v1/inbox", { headers: bearer })).status).toBe(200);
    expect((await app.request("/v1/inbox", { headers: { cookie, Authorization: "Bearer invalid" } })).status).toBe(401);
    expect((await app.request("/v1/me", { headers: { cookie: `${sessionCookieName(ORIGIN)}=${SERVICE}` } })).status).toBe(401);
    expect((await app.request("/auth/logout", { method: "POST", headers: { cookie, Origin: ORIGIN } })).status).toBe(200);
    expect((await app.request("/v1/inbox", { headers: { cookie } })).status).toBe(401);
    expect((await app.request("/v1/inbox", { headers: bearer })).status).toBe(401);
    expect(await (await app.request("/auth/session", { headers: { cookie } })).json()).toEqual({ signIn: true, identity: null });
  });

  test("browser readers cannot acquire approver powers, and logout clears and revokes their session", async () => {
    const fake = fakeNotOrganic({ approved: true, product: "ephyra", did: OTHER });
    const { app } = await server(fake);
    const cookie = browserCookie(await browserLogin(app, fake)).split(";")[0]!;
    const headers = { cookie, Origin: ORIGIN };
    expect(await (await app.request("/v1/me", { headers })).json()).toMatchObject({ principal: OTHER, approver: false });
    expect((await app.request("/v1/drafts", { method: "POST", headers, body: "{}" })).status).toBe(403);
    const logout = await app.request("/auth/logout", { method: "POST", headers });
    expect(logout.status).toBe(200);
    expect(browserCookie(logout)).toContain("Max-Age=0");
    expect((await app.request("/auth/me", { headers })).status).toBe(401);
    expect((await app.request("/auth/logout", { method: "POST", headers })).status).toBe(200);
  });

  test("login redirects to the portal with PKCE, the exact origin and Ephyra's scopes", async () => {
    const fake = fakeNotOrganic({ approved: true, product: "ephyra" });
    const { app } = await server(fake);
    const res = await app.request("/auth/login");
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(AUTHORIZE);
    expect(to.searchParams.get("client_id")).toBe(ORIGIN);
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("scope")).toBe("wallet:read usage:read judgement:evaluate extraction:run");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("agent claim return survives bound sign-in while arbitrary redirects and CLI combinations are refused", async () => {
    const fake = fakeNotOrganic({ approved: true, product: "ephyra" });
    const { app } = await server(fake);
    const returnTo = `/agent/claim?attempt=${"x".repeat(43)}`;
    const callback = await browserLogin(app, fake, `?returnTo=${encodeURIComponent(returnTo)}`);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(returnTo);
    const access = await browserLogin(app, fake, "?returnTo=%2Fagent%2Faccess");
    expect(access.headers.get("location")).toBe("/agent/access");
    for (const target of ["https://evil.test/", "//evil.test/", "/app/", `${returnTo}&next=https://evil.test/`,
      "/agent/access?next=https://evil.test/"]) {
      expect((await app.request(`/auth/login?returnTo=${encodeURIComponent(target)}`)).status).toBe(400);
    }
    const challenge = await sha256b64url("v".repeat(43));
    expect((await app.request(`/auth/login?cli=${challenge}&returnTo=${encodeURIComponent(returnTo)}`)).status).toBe(400);
  });

  test("CLI login: browser approval releases a session that can approve trails; service token cannot", async () => {
    const fake = fakeNotOrganic({ approved: true, product: "ephyra" });
    const { app } = await server(fake);
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = await sha256b64url(verifier);
    const poll = () =>
      app.request("/auth/cli/token", { method: "POST", body: JSON.stringify({ verifier }), headers: { "content-type": "application/json" } });

    const callback = await browserLogin(app, fake, `?cli=${challenge}`);
    expect(callback.status).toBe(200);
    expect(browserCookie(callback)).toBeUndefined();
    const html = await callback.text();
    expect(html).toContain("Sign in to the Ephyra CLI?");
    expect((await poll()).status).toBe(428); // waiting for the human to press Approve

    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const approve = await app.request("/auth/cli/approve", {
      method: "POST", body: new URLSearchParams({ challenge, csrf }), headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(approve.status).toBe(200);
    const got = await poll();
    expect(got.status).toBe(200);
    const { token, did, approver } = await got.json() as { token: string; did: string; approver: boolean };
    expect(did).toBe(DID);
    expect(approver).toBe(true);
    expect((await poll()).status).toBe(404); // single use

    const me = await app.request("/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ did: DID, approver: true });
    expect((await app.request("/v1/inbox", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    // Mutations need a signed-in approver once sign-in is configured; the service token is refused.
    const asService = await app.request("/v1/trails/x/claim", {
      method: "POST", headers: { Authorization: `Bearer ${SERVICE}`, "X-Ephyra-Principal": DID }, body: "{}",
    });
    expect(asService.status).toBe(403);
  });

  test("a CLI poll with the wrong verifier, or a callback without the login cookie, gets nothing", async () => {
    const fake = fakeNotOrganic({ approved: true, product: "ephyra" });
    const { app } = await server(fake);
    const login = await app.request("/auth/login");
    const back = new URL(fake.approve(login.headers.get("location")!));
    const noCookie = await app.request(`${back.pathname}${back.search}`);
    expect(noCookie.status).toBe(400);
    const bad = await app.request("/auth/cli/token", {
      method: "POST", body: JSON.stringify({ verifier: "x".repeat(43) }), headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(404);
  });

  test("a signed-in account that is not an approver can read but not change trails", async () => {
    const fake = fakeNotOrganic({ approved: true, product: "ephyra", did: OTHER });
    const { app } = await server(fake);
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const callback = await browserLogin(app, fake, `?cli=${await sha256b64url(verifier)}`);
    const html = await callback.text();
    expect(html).toContain("not on this deployment's approver list");
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    await app.request("/auth/cli/approve", {
      method: "POST", body: new URLSearchParams({ challenge: await sha256b64url(verifier), csrf }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const collected = await app.request("/auth/cli/token", {
      method: "POST", body: JSON.stringify({ verifier }), headers: { "content-type": "application/json" },
    });
    const { token } = await collected.json() as { token: string };
    expect((await app.request("/v1/inbox", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    const change = await app.request("/v1/trails/x/claim", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
    expect(change.status).toBe(403);
  });

  test("unapproved origin and wrong product are reported, not hidden", async () => {
    const unapproved = fakeNotOrganic({ approved: false, product: "ephyra" });
    const a = await server(unapproved);
    const r1 = await browserLogin(a.app, unapproved);
    expect(r1.status).toBe(403);
    expect(await r1.text()).toContain("integration_not_approved");

    const wrong = fakeNotOrganic({ approved: true, product: "keating" });
    const b = await server(wrong);
    const r2 = await browserLogin(b.app, wrong);
    expect(r2.status).toBe(403);
    expect(await r2.text()).toContain("not issued for Ephyra");
  });

  test("hosted judgement runs on the billing account's session and rotates its refresh token", async () => {
    const fake = fakeNotOrganic({ approved: true, product: "ephyra" });
    const composed = await server(fake, { EPHYRA_DECIDE: "notorganic" });
    await browserLogin(composed.app, fake); // the approver signs in once in the browser
    const opsHeaders = { Authorization: `Bearer ${SERVICE}`, "X-Ephyra-Principal": "ops" };
    const ops = await (await composed.app.request("/v1/ops", { headers: opsHeaders })).json() as { backends: { decide: string } };
    expect(ops.backends.decide).toBe("notorganic-judgement");

    const decide = composed.decide!;
    const req = { state: "a signal", questions: { actionable: { type: "noul" as const, instructions: "Is it ours?" } } };
    const first = await decide.decide(req, { idempotencyKey: "k1" });
    expect(first.model).toBe("judgement-jev/jev-1.14");
    expect(first.answers.actionable).toEqual({ type: "noul", noul: 0.9 });
    expect(fake.refreshCount).toBe(0); // the access token from sign-in is still fresh

    composed.signIn!.expireCachedTokens(); // as if five minutes passed
    await decide.decide(req, { idempotencyKey: "k2" });
    expect(fake.refreshCount).toBe(1);
    composed.signIn!.expireCachedTokens();
    await decide.decide(req, { idempotencyKey: "k3" }); // only works if the rotated refresh token was stored
    expect(fake.refreshCount).toBe(2);
  });
});
