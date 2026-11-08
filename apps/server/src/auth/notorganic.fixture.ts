// Fictional Not Organic gateway for offline sign-in tests and the local browser harness.
import { b64url, sha256b64url, type Jwk } from "./crypto.ts";
const ISSUER = "https://api.notorganic.test";
const DID = "did:plc:approver123";

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
export function fakeNotOrganic(opts: {
  approved: boolean; product: string; did?: string;
  honorRequestedScopes?: boolean;
  knowledge?: (path: string, body: Record<string, unknown>, did: string) => Response;
}) {
  const codes = new Map<string, { challenge: string; clientId: string; redirect: string; scope: string }>();
  const refresh = new Map<string, { jkt: string; did: string; scope: string }>();
  const access = new Map<string, { jkt: string; did: string }>();
  let refreshCount = 0;
  const token = (did: string, jkt: string, scope = "judgement:evaluate") => {
    const claims = { iss: ISSUER, sub: did, product: opts.product, cnf: { jkt } };
    const t = `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${crypto.randomUUID()}`;
    access.set(t, { jkt, did });
    const r = crypto.randomUUID();
    refresh.set(r, { jkt, did, scope });
    return { access_token: t, token_type: "DPoP", expires_in: 300, scope, refresh_token: r, refresh_expires_in: 86400 };
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
      return json(token(opts.did ?? DID, await thumbprint(body.dpop_jwk), opts.honorRequestedScopes ? code.scope : undefined));
    }
    if (url.pathname === "/v1/public/device/token") {
      const r = refresh.get(body.refresh_token);
      if (!r) return json({ error: { code: "invalid_refresh" } }, 401);
      if ((await verifyProof(headers.get("dpop")!, "POST", input)) !== r.jkt) return json({ error: { code: "dpop_mismatch" } }, 401);
      refresh.delete(body.refresh_token); // rotation: old refresh token is now dead
      refreshCount++;
      return json(token(r.did, r.jkt, r.scope));
    }
    const auth = (headers.get("authorization") ?? "").replace(/^DPoP /, "");
    const a = access.get(auth);
    if (!a || (await verifyProof(headers.get("dpop")!, init?.method ?? "GET", input, auth)) !== a.jkt) return json({ error: { code: "unauthorized" } }, 401);
    if (url.pathname === "/v1/account") return json({ account: { did: a.did, handle: "approver.test" } });
    if (url.pathname.startsWith("/v1/knowledge/") && opts.knowledge) return opts.knowledge(url.pathname, body, a.did);
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
    codes.set(code, { challenge: q.get("code_challenge")!, clientId: q.get("client_id")!, redirect: q.get("redirect_uri")!, scope: q.get("scope") ?? "" });
    return `${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}`;
  };
  return { fetcher, approve, get refreshCount() { return refreshCount; } };
}
