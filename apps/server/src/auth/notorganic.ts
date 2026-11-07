// Sign in with Not Organic: PKCE authorization at the portal, DPoP-bound device session at the gateway.
// Mirrors Baste's bridge (server-held keys and refresh tokens; the browser never sees upstream secrets),
// but persists sessions in Convex so a restart does not sign everyone out.
import {
  dpopProof, jwtClaims, newDpopKeys, randomToken, restoreDpopKeys, sha256b64url, type Fetch, type Jwk, type SecretBox,
} from "./crypto.ts";
import type { AuthStore, CliGrant, SessionRecord } from "./store.ts";

export type NotOrganicConfig = {
  /** Gateway origin, e.g. https://api.notorganic.info */
  issuer: string;
  /** Portal authorize endpoint, e.g. https://id.notorganic.info/authorize */
  authorizationUrl: string;
  /** Ephyra's own public origin; also the OAuth client_id. */
  publicOrigin: string;
  /** Product the access token must carry (the gateway derives it from the registered client origin). */
  product: string;
  scopes: string[];
};

export type Principal = { did: string; handle?: string };

type Sealed = { refreshToken: string; privateJwk: Jwk; publicJwk: Jwk; scope: string };
type TokenResponse = { access_token: string; token_type: string; expires_in: number; scope?: string; refresh_token?: string; refresh_expires_in?: number };

export class SignInError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 502, message: string) { super(message); }
}

const SESSION_FALLBACK_TTL_MS = 30 * 24 * 3600_000;

/** Human-checkable code shown in the terminal and on the approval page. */
export function userCode(challenge: string): string {
  const c = challenge.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `${c.slice(0, 4)}-${c.slice(4, 8)}`;
}

export class NotOrganicSignIn {
  /** Access tokens minted from a session, cached until shortly before expiry; one refresh in flight per session. */
  private cache = new Map<string, { token: string; keys: CryptoKeyPair; publicJwk: Jwk; expiresMs: number }>();
  private inflight = new Map<string, Promise<{ token: string; keys: CryptoKeyPair; publicJwk: Jwk }>>();

  constructor(
    readonly config: NotOrganicConfig,
    private readonly store: AuthStore,
    private readonly box: SecretBox,
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
  ) {}

  get redirectUri(): string { return `${this.config.publicOrigin}/auth/callback`; }

  /** The transport used for every Not Organic call. */
  get fetch(): Fetch { return this.fetcher; }

  /** Drop cached access tokens so the next call refreshes (tests; also safe operationally). */
  expireCachedTokens(): void { this.cache.clear(); }

  /** Start a login. `browser` is a random value the caller sets as an HttpOnly cookie. */
  async begin(browser: string, cliChallenge?: string): Promise<string> {
    if (cliChallenge !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(cliChallenge)) throw new SignInError(400, "invalid CLI challenge");
    const state = randomToken();
    const verifier = randomToken();
    await this.store.putTx({
      state, verifier, browserHash: await sha256b64url(browser), createdMs: Date.now(),
      ...(cliChallenge ? { cliChallenge } : {}),
    });
    const url = new URL(this.config.authorizationUrl);
    const params = {
      client_id: this.config.publicOrigin, redirect_uri: this.redirectUri, response_type: "code", code_challenge_method: "S256",
      code_challenge: await sha256b64url(verifier), scope: this.config.scopes.join(" "), state, prompt: "select_account",
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  /**
   * Finish a login. Returns the new session token, and for CLI logins a grant the browser must approve
   * before the CLI can collect the token.
   */
  async complete(
    params: URLSearchParams, browser: string | undefined,
  ): Promise<{ token: string; principal: Principal; cli?: { challenge: string; csrf: string } }> {
    const state = params.get("state") ?? "";
    const tx = state ? await this.store.takeTx(state) : null;
    if (!tx || !browser || (await sha256b64url(browser)) !== tx.browserHash) throw new SignInError(400, "Sign-in could not be verified. Start again.");
    if (params.has("error")) throw new SignInError(400, `Sign-in was not completed (${params.get("error")?.slice(0, 80)}).`);
    const code = params.get("code");
    if (!code || code.length > 512) throw new SignInError(400, "Sign-in could not be verified. Start again.");

    const dpop = await newDpopKeys();
    const token = await this.post<TokenResponse>("/v1/public/token", {
      code, code_verifier: tx.verifier, client_id: this.config.publicOrigin, redirect_uri: this.redirectUri,
      dpop_jwk: dpop.publicJwk, device_session: true, device_name: "Ephyra",
    });
    this.checkToken(token);
    if (!token.refresh_token) throw new SignInError(502, "Not Organic did not return a device session.");
    // Authenticate through the issuer before trusting any claim; never trust a DID from the browser.
    const account = await this.get<{ account?: { did?: string; handle?: string } }>("/v1/account", token.access_token, dpop.keys, dpop.publicJwk);
    const did = account.account?.did;
    const claims = jwtClaims(token.access_token);
    if (!did || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(did) || did !== claims.sub) {
      throw new SignInError(403, "Not Organic returned an account that does not match the session.");
    }
    const principal: Principal = { did, ...(typeof account.account?.handle === "string" ? { handle: account.account.handle } : {}) };

    const sessionToken = randomToken();
    const now = Date.now();
    const record: SessionRecord = {
      sessionHash: await sha256b64url(sessionToken), ...principal, version: 0, createdMs: now,
      expiresMs: now + (token.refresh_expires_in ? token.refresh_expires_in * 1000 : SESSION_FALLBACK_TTL_MS),
      sealed: await this.box.seal({
        refreshToken: token.refresh_token, privateJwk: dpop.privateJwk, publicJwk: dpop.publicJwk, scope: token.scope ?? "",
      } satisfies Sealed),
    };
    await this.store.putSession(record);
    this.cache.set(record.sessionHash, { token: token.access_token, keys: dpop.keys, publicJwk: dpop.publicJwk, expiresMs: now + token.expires_in * 1000 });

    if (!tx.cliChallenge) return { token: sessionToken, principal };
    const csrf = randomToken();
    const grant: CliGrant = { challenge: tx.cliChallenge, sealedToken: await this.box.seal(sessionToken), csrf, approved: false, createdMs: now };
    await this.store.putGrant(grant);
    return { token: sessionToken, principal, cli: { challenge: tx.cliChallenge, csrf } };
  }

  async approveCli(challenge: string, csrf: string): Promise<boolean> {
    return this.store.approveGrant(challenge, csrf);
  }

  /** The CLI proves it started the login by presenting the preimage of its challenge. */
  async collectCli(verifier: string): Promise<{ token: string; principal: Principal } | "pending" | null> {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return null;
    const challenge = await sha256b64url(verifier);
    const grant = await this.store.takeApprovedGrant(challenge);
    if (!grant) return (await this.store.getGrant(challenge)) ? "pending" : null;
    const token = await this.box.open<string>(grant.sealedToken);
    const principal = await this.authenticate(token);
    return principal ? { token, principal } : null;
  }

  async authenticate(sessionToken: string): Promise<Principal | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
    const record = await this.store.getSession(await sha256b64url(sessionToken));
    if (!record || record.expiresMs <= Date.now()) return null;
    return { did: record.did, ...(record.handle ? { handle: record.handle } : {}) };
  }

  async logout(sessionToken: string): Promise<void> {
    const hash = await sha256b64url(sessionToken);
    const record = await this.store.getSession(hash);
    if (!record) return;
    await this.store.deleteSession(hash);
    this.cache.delete(hash);
    try {
      const sealed = await this.box.open<Sealed>(record.sealed);
      const keys = await restoreDpopKeys(sealed.privateJwk, sealed.publicJwk);
      const url = `${this.config.issuer}/v1/public/device/revoke`;
      await this.fetcher(url, {
        method: "POST", headers: { "content-type": "application/json", dpop: await dpopProof(keys, sealed.publicJwk, url, "POST") },
        body: JSON.stringify({ refresh_token: sealed.refreshToken }),
      });
    } catch { /* local authority is already removed */ }
  }

  /**
   * Credentials for calling Not Organic on behalf of `did` (hosted models on that account's wallet):
   * the latest session's DPoP keys and a fresh access token. Refresh tokens rotate; the new one is stored
   * with compare-and-swap before the access token is used.
   */
  async credentialsFor(did: string): Promise<{ token: string; keys: CryptoKeyPair; publicJwk: Jwk }> {
    const record = await this.store.latestSessionFor(did, Date.now());
    if (!record) throw new SignInError(401, `No Not Organic session for ${did}; run \`ephyra login\` with that account.`);
    const cached = this.cache.get(record.sessionHash);
    if (cached && cached.expiresMs - Date.now() > 30_000) return cached;
    let pending = this.inflight.get(record.sessionHash);
    if (!pending) {
      pending = this.refresh(record).finally(() => this.inflight.delete(record.sessionHash));
      this.inflight.set(record.sessionHash, pending);
    }
    return pending;
  }

  private async refresh(record: SessionRecord) {
    const sealed = await this.box.open<Sealed>(record.sealed);
    const keys = await restoreDpopKeys(sealed.privateJwk, sealed.publicJwk);
    const url = `${this.config.issuer}/v1/public/device/token`;
    const res = await this.fetcher(url, {
      method: "POST", headers: { "content-type": "application/json", dpop: await dpopProof(keys, sealed.publicJwk, url, "POST") },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: sealed.refreshToken }),
    });
    if (!res.ok) throw new SignInError(res.status === 401 || res.status === 403 ? 401 : 502, `Not Organic session refresh failed (${res.status}).`);
    const token = (await res.json()) as TokenResponse;
    this.checkToken(token);
    if (token.refresh_token && token.refresh_token !== sealed.refreshToken) {
      const next = await this.box.seal({ ...sealed, refreshToken: token.refresh_token, scope: token.scope ?? sealed.scope } satisfies Sealed);
      if (!(await this.store.updateSealed(record.sessionHash, record.version, next))) {
        throw new SignInError(502, "Session was refreshed concurrently; retry.");
      }
    }
    const value = { token: token.access_token, keys, publicJwk: sealed.publicJwk, expiresMs: Date.now() + token.expires_in * 1000 };
    this.cache.set(record.sessionHash, value);
    return value;
  }

  /** Every token must come from the configured issuer for the registered product; never spend another product's grant. */
  private checkToken(token: TokenResponse): void {
    if (!token || typeof token.access_token !== "string" || token.token_type !== "DPoP" || !(token.expires_in > 0)) {
      throw new SignInError(502, "Not Organic returned an invalid session.");
    }
    const claims = jwtClaims(token.access_token);
    if (claims.iss !== this.config.issuer || claims.product !== this.config.product) {
      throw new SignInError(403, `This Not Organic session is not issued for Ephyra (product ${String(claims.product)}).`);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetcher(`${this.config.issuer}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return this.read<T>(res);
  }

  private async get<T>(path: string, accessToken: string, keys: CryptoKeyPair, publicJwk: Jwk): Promise<T> {
    const url = `${this.config.issuer}${path}`;
    const res = await this.fetcher(url, {
      headers: { authorization: `DPoP ${accessToken}`, dpop: await dpopProof(keys, publicJwk, url, "GET", accessToken) },
    });
    return this.read<T>(res);
  }

  private async read<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (res.ok) return body as T;
    if (body.error?.code === "integration_not_approved") {
      throw new SignInError(403, "Not Organic has not approved this Ephyra origin yet (integration_not_approved).");
    }
    throw new SignInError(res.status >= 500 ? 502 : 400, `Not Organic rejected the sign-in (${res.status}${body.error?.code ? ` ${body.error.code}` : ""}).`);
  }
}
