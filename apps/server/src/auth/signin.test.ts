// Sign in with Not Organic, end to end against a fake Not Organic that enforces what the real gateway does:
// PKCE S256, an approved client origin, DPoP proofs bound to the key given at token exchange, refresh rotation.
import { describe, expect, test } from "bun:test";
import { b64url, sha256b64url, type Jwk } from "./crypto.ts";
import { compose } from "../compose.ts";
import { readConfig } from "../config.ts";

const ISSUER = "https://api.notorganic.test";
const AUTHORIZE = "https://id.notorganic.test/authorize";
const ORIGIN = "https://ephyra.example";
const DID = "did:plc:approver123";
const OTHER = "did:plc:someoneelse";
const SERVICE = "s".repeat(32);

async function thumbprint(jwk: Jwk): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))));
}

async function verifyProof(proof: string, method: string, url: string, accessToken?: string): Promise<string> {
  const [h, p, sig] = proof.split(".");
  const header = JSON.parse(Buffer.from(h!, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
  if (header.typ !== "dpop+jwt" || header.alg !== "ES256") throw new Error("bad dpop header");
  const key = await crypto.subtle.importKey("jwk", header.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(sig!, "base64url"), new TextEncoder().encode(`${h}.${p}`));
  if (!ok || payload.htm !== method || payload.htu !== url) throw new Error("bad dpop proof");
  if (accessToken && payload.ath !== (await sha256b64url(accessToken))) throw new Error("bad ath");
  return thumbprint(header.jwk);
}

/** A fake Not Organic gateway + portal. `approved` mimics PUBLIC_CLIENT_PRODUCT_CATALOG. */
function fakeNotOrganic(opts: { approved: boolean; product: string; did?: string }) {
  const codes = new Map<string, { challenge: string; clientId: string; redirect: string }>();
  const refresh = new Map<string, { jkt: string; did: string }>();
  const access = new Map<string, { jkt: string; did: string }>();
  let refreshCount = 0;
  const token = (did: string, jkt: string) => {
    const claims = { iss: ISSUER, sub: did, product: opts.product, cnf: { jkt } };
    const t = `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${crypto.randomUUID()}`;
    access.set(t, { jkt, did });
    const r = crypto.randomUUID();
    refresh.set(r, { jkt, did });
    return { access_token: t, token_type: "DPoP", expires_in: 300, scope: "judgement:evaluate", refresh_token: r, refresh_expires_in: 86400 };
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const headers = new Headers(init?.headers);
    if (url.pathname === "/v1/public/token") {
      if (!opts.approved) return json({ error: { code: "integration_not_approved" } }, 403);
      const code = codes.get(body.code);
      codes.delete(body.code);
      if (!code || code.clientId !== body.client_id || code.redirect !== body.redirect_uri) return json({ error: { code: "invalid_grant" } }, 400);
      if ((await sha256b64url(body.code_verifier)) !== code.challenge) return json({ error: { code: "invalid_pkce" } }, 400);
      return json(token(opts.did ?? DID, await thumbprint(body.dpop_jwk)));
    }
    if (url.pathname === "/v1/public/device/token") {
      const r = refresh.get(body.refresh_token);
      if (!r) return json({ error: { code: "invalid_refresh" } }, 401);
      if ((await verifyProof(headers.get("dpop")!, "POST", input)) !== r.jkt) return json({ error: { code: "dpop_mismatch" } }, 401);
      refresh.delete(body.refresh_token); // rotation: old refresh token is now dead
      refreshCount++;
      return json(token(r.did, r.jkt));
    }
    const auth = (headers.get("authorization") ?? "").replace(/^DPoP /, "");
    const a = access.get(auth);
    if (!a || (await verifyProof(headers.get("dpop")!, init?.method ?? "GET", input, auth)) !== a.jkt) return json({ error: { code: "unauthorized" } }, 401);
    if (url.pathname === "/v1/account") return json({ account: { did: a.did, handle: "approver.test" } });
    if (url.pathname === "/v1/judgement") {
      const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: 0.9 }]));
      return json({ model: "judgement-jev/jev-1.14", answers });
    }
    if (url.pathname === "/v1/public/device/revoke") return json({ ok: true });
    return json({ error: { code: "not_found" } }, 404);
  };
  /** What the portal does after the user approves: issue a code and redirect back. */
  const approve = (authorizeUrl: string) => {
    const u = new URL(authorizeUrl);
    const code = crypto.randomUUID();
    const q = u.searchParams;
    codes.set(code, { challenge: q.get("code_challenge")!, clientId: q.get("client_id")!, redirect: q.get("redirect_uri")! });
    return `${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}`;
  };
  return { fetcher, approve, get refreshCount() { return refreshCount; } };
}

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

  test("CLI login: browser approval releases a session that can approve trails; service token cannot", async () => {
    const fake = fakeNotOrganic({ approved: true, product: "ephyra" });
    const { app } = await server(fake);
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = await sha256b64url(verifier);
    const poll = () =>
      app.request("/auth/cli/token", { method: "POST", body: JSON.stringify({ verifier }), headers: { "content-type": "application/json" } });

    const callback = await browserLogin(app, fake, `?cli=${challenge}`);
    expect(callback.status).toBe(200);
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
