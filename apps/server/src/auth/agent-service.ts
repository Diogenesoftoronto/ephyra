import { z } from "zod";
import { randomToken, sha256b64url, b64url, safeEqual } from "./crypto.ts";
import type { NotOrganicSignIn } from "./notorganic.ts";
import type {
  AgentBinding, AgentPrincipal, AgentRegistration, AgentRepository, AgentScope, AgentStore,
} from "./agent-store.ts";

export const AGENT_SCOPES = ["bootstrap:read", "bootstrap:context", "bootstrap:run"] as const;
export const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
export const ASSERTION_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CLAIM_MS = 30 * 60_000;
const ATTEMPT_MS = 10 * 60_000;
const REGISTRATION_MS = 30 * 24 * 3600_000;
const ACCESS_MS = 5 * 60_000;
const ASSERTION_MS = 24 * 3600_000;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

export class AgentAuthError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503,
    readonly code: string, message: string, readonly interval?: number) { super(message); }
}

function repositoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && !/[\s\0-\x1f\x7f]/.test(value) && url.href === value;
  } catch { return false; }
}
const Repository = z.object({
  url: z.string().min(1).max(2048).refine(repositoryUrl),
  branch: z.string().min(1).max(200).refine((branch) =>
    !branch.startsWith("-") && !branch.startsWith("/") && !branch.endsWith("/")
    && !branch.endsWith(".") && !branch.endsWith(".lock") && !branch.includes("..")
    && !branch.includes("@{") && !branch.includes("//") && !/[\s~^:?*\[\\\0-\x1f\x7f]/.test(branch)),
}).strict();
const RegisterInput = z.object({
  type: z.literal("anonymous"),
  intended_owner: z.string().max(300).regex(/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/),
  repository: Repository,
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1).max(3).default(["bootstrap:read", "bootstrap:context"]),
}).strict().refine((input) => input.scopes.includes("bootstrap:read"));

export type AgentAccessOptions = {
  store: AgentStore;
  origin: string;
  signingSecret: string;
  signIn: Pick<NotOrganicSignIn, "authenticate">;
  resolveBinding: (did: string, repository: AgentRepository, registrationId: string) => Promise<AgentBinding>;
  currentBinding: (did: string) => Promise<AgentBinding | null>;
  now?: () => number;
};

const matches = (a: AgentBinding, b: AgentBinding) => a.ownerDid === b.ownerDid && a.workspaceId === b.workspaceId
  && a.repository.url === b.repository.url && a.repository.branch === b.repository.branch
  && a.repositoryRevision === b.repositoryRevision;
const proposalMatches = (binding: AgentBinding | null, record: AgentRegistration): binding is AgentBinding =>
  binding?.ownerDid === record.intendedOwner && binding.repository.url === record.repository.url
  && binding.repository.branch === record.repository.branch;

/** Service-owned credentials. They are never accepted as human sessions or upstream identity assertions. */
export class AgentAccess {
  readonly origin: string;
  readonly resource: string;
  readonly signIn: AgentAccessOptions["signIn"];
  private readonly now: () => number;
  private readonly key: Promise<CryptoKey>;
  private registrationsInWindow = 0;
  private windowMs = 0;

  constructor(private readonly options: AgentAccessOptions) {
    this.origin = new URL(options.origin).origin;
    this.resource = `${this.origin}/v1/agent/`;
    this.signIn = options.signIn;
    this.now = options.now ?? Date.now;
    const raw = Buffer.from(options.signingSecret, options.signingSecret.includes("-")
      || options.signingSecret.includes("_") ? "base64url" : "base64");
    if (raw.length !== 32) throw new Error("Agent signing key must contain 32 bytes.");
    this.key = crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]).then((root) =>
      crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("ephyra-agent-auth-v1"),
        info: encoder.encode(this.origin) }, root, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]));
  }

  protectedResource() {
    return { resource: this.resource, resource_name: "Ephyra repository bootstrap",
      authorization_servers: [this.origin], scopes_supported: [...AGENT_SCOPES], bearer_methods_supported: ["header"] };
  }
  authorizationServer() {
    return { issuer: this.origin, token_endpoint: `${this.origin}/oauth2/token`,
      revocation_endpoint: `${this.origin}/oauth2/revoke`, grant_types_supported: [ASSERTION_GRANT, CLAIM_GRANT],
      token_endpoint_auth_methods_supported: ["none"],
      agent_auth: { skill: `${this.origin}/auth.md`, identity_endpoint: `${this.origin}/agent/identity`,
        claim_endpoint: `${this.origin}/agent/identity/claim`, identity_types_supported: ["anonymous"],
        claim_binding: "ephyra:notorganic-did-v1", pre_claim_scopes: [], post_claim_scopes: [...AGENT_SCOPES] } };
  }
  challenge() {
    return `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource"`;
  }

  async register(input: unknown) {
    const parsed = RegisterInput.safeParse(input);
    if (!parsed.success) throw new AgentAuthError(400, "invalid_request",
      "Use anonymous registration with an intended Not Organic DID, HTTPS repository, branch and supported bootstrap scopes.");
    const now = this.now();
    // A bounded per-replica admission limit complements durable per-ceremony attempt and polling limits.
    if (now - this.windowMs >= 60_000) { this.windowMs = now; this.registrationsInWindow = 0; }
    if (++this.registrationsInWindow > 60)
      throw new AgentAuthError(429, "slow_down", "Too many registration requests. Try again in one minute.", 60);
    const claimToken = randomToken();
    const record: AgentRegistration = {
      id: randomToken(18), revision: 0, version: 0, intendedOwner: parsed.data.intended_owner,
      repository: parsed.data.repository, scopes: [...new Set(parsed.data.scopes)],
      claimHash: await sha256b64url(claimToken), claimExpiresMs: now + CLAIM_MS,
      createdMs: now, expiresMs: now + CLAIM_MS,
    };
    await this.options.store.create(record);
    return { registration_id: record.id, type: "anonymous", identity_assertion: await this.assertion(record),
      assertion_expires_in: Math.floor(CLAIM_MS / 1000), pre_claim_scopes: [], post_claim_scopes: record.scopes,
      claim_token: claimToken, claim_token_expires_in: Math.floor(CLAIM_MS / 1000),
      claim_url: `${this.origin}/agent/identity/claim`, claim_binding: "ephyra:notorganic-did-v1" };
  }

  private active(record: AgentRegistration | null): record is AgentRegistration {
    return !!record && record.revokedMs === undefined && record.expiresMs > this.now();
  }
  private async claimRecord(token: string) {
    if (!secretPattern.test(token)) throw new AgentAuthError(400, "invalid_request", "The claim token is invalid.");
    const record = await this.options.store.byClaim(await sha256b64url(token));
    if (!this.active(record) || record.claimExpiresMs <= this.now())
      throw new AgentAuthError(410, "claim_expired", "Register again to start a new claim.");
    return record;
  }
  private async replace(record: AgentRegistration, next: AgentRegistration) {
    next.revision = record.revision + 1;
    return this.options.store.replace(next, record.revision);
  }
  async beginClaim(input: unknown) {
    const parsed = z.object({ claim_token: z.string(), intended_owner: z.string().max(300) }).strict().safeParse(input);
    if (!parsed.success) throw new AgentAuthError(400, "invalid_request", "Provide claim_token and intended_owner DID.");
    for (let retry = 0; retry < 8; retry++) {
      const record = await this.claimRecord(parsed.data.claim_token);
      if (record.intendedOwner !== parsed.data.intended_owner)
        throw new AgentAuthError(403, "owner_mismatch", "This claim was registered for another account.");
      if (record.binding) throw new AgentAuthError(409, "already_claimed", "Poll the token endpoint for the approved claim.");
      if ((record.failedCodes ?? 0) >= 5)
        throw new AgentAuthError(403, "access_denied", "Too many incorrect codes. Register a new agent request.");
      const attempt = randomToken();
      const attemptId = randomToken(18);
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
      const next = { ...record, attemptHash: await sha256b64url(attempt), attemptId,
        codeHash: await sha256b64url(`${record.id}:${attemptId}:${code}`),
        attemptExpiresMs: this.now() + ATTEMPT_MS, intervalSeconds: record.intervalSeconds ?? 5 };
      if (!await this.replace(record, next)) continue;
      return { registration_id: record.id, claim_attempt_id: attemptId, status: "initiated",
        expires_at: new Date(next.attemptExpiresMs).toISOString(), claim_binding: "ephyra:notorganic-did-v1",
        claim_attempt: { user_code: code, expires_in: Math.floor(ATTEMPT_MS / 1000),
          verification_uri: `${this.origin}/agent/claim?attempt=${attempt}`, interval: next.intervalSeconds } };
    }
    throw new AgentAuthError(409, "conflict", "The claim changed. Read its current state before retrying.");
  }

  async attempt(token: string) {
    if (!secretPattern.test(token)) throw new AgentAuthError(404, "invalid_request", "This claim link is unavailable.");
    const record = await this.options.store.byAttempt(await sha256b64url(token));
    if (!this.active(record) || !record.attemptExpiresMs || record.attemptExpiresMs <= this.now()
      || (record.failedCodes ?? 0) >= 5)
      throw new AgentAuthError(410, "expired_token", "This claim link expired. Ask the agent for a new request.");
    return record;
  }
  async csrf(attempt: string, did: string, session: string) {
    return this.signed({ purpose: "agent-claim-csrf-v1", attempt: await sha256b64url(attempt),
      did, session: await sha256b64url(session), exp: Math.floor((this.now() + ATTEMPT_MS) / 1000) });
  }
  async approve(attempt: string, code: string, csrf: string, did: string, session: string) {
    const proof = await this.verified(csrf, "ephyra-agent-csrf+jwt");
    if (proof?.purpose !== "agent-claim-csrf-v1" || proof.did !== did
      || proof.attempt !== await sha256b64url(attempt) || proof.session !== await sha256b64url(session))
      throw new AgentAuthError(403, "access_denied", "The approval form expired. Reload the claim page.");
    for (let retry = 0; retry < 8; retry++) {
      const record = await this.attempt(attempt);
      if (record.intendedOwner !== did)
        throw new AgentAuthError(403, "owner_mismatch", "Sign in as the Not Organic account named by the agent.");
      if (record.binding) return;
      const codeHash = await sha256b64url(`${record.id}:${record.attemptId}:${code}`);
      if (!/^\d{6}$/.test(code) || !safeEqual(record.codeHash ?? "", codeHash)) {
        if (!await this.replace(record, { ...record, failedCodes: (record.failedCodes ?? 0) + 1 })) continue;
        throw new AgentAuthError(403, "access_denied", "The code does not match. Check the six digits shown by your agent.");
      }
      // Verify the code before any repository side effect; CAS gives one callback owner across replicas.
      if (!record.resolvingBinding) {
        const resolving = { ...record, resolvingBinding: true };
        if (!await this.replace(record, resolving)) continue;
        try {
          const binding = await this.options.resolveBinding(did, record.repository, record.id);
          if (!proposalMatches(binding, record)) throw new Error("Binding mismatch.");
        } catch {
          // Keep the durable resolving marker. A future approval may reconcile saved settings, never repeat the write.
          throw new AgentAuthError(409, "reconciliation_required",
            "The repository connection could not be confirmed. Check it in Ephyra settings, then reopen this request.");
        }
      }
      const current = await this.options.store.get(record.id);
      if (!this.active(current) || current.attemptHash !== record.attemptHash)
        throw new AgentAuthError(409, "conflict", "The claim changed. Reopen the latest request.");
      if (current.binding) return;
      const binding = await this.options.currentBinding(did);
      if (!proposalMatches(binding, current)) throw new AgentAuthError(409, "reconciliation_required",
        "Connect this exact repository and branch in Ephyra settings, then reopen this request.");
      if (!await this.replace(current, { ...current, binding, version: current.version + 1,
        expiresMs: this.now() + REGISTRATION_MS })) continue;
      return;
    }
    throw new AgentAuthError(409, "conflict", "The claim changed. Reopen the latest request.");
  }

  async poll(claimToken: string, resource?: string) {
    this.checkResource(resource);
    for (let retry = 0; retry < 8; retry++) {
      const record = await this.claimRecord(claimToken);
      const interval = record.intervalSeconds ?? 5;
      const early = record.lastPollMs !== undefined && this.now() - record.lastPollMs < interval * 1000;
      const next = { ...record, lastPollMs: this.now(), intervalSeconds: early ? Math.min(60, interval + 5) : interval };
      if (!await this.replace(record, next)) continue;
      if (early) throw new AgentAuthError(400, "slow_down", "Wait before polling again.", next.intervalSeconds);
      if (!record.attemptExpiresMs || record.attemptExpiresMs <= this.now())
        throw new AgentAuthError(400, "expired_token", "Start a new claim attempt using the same claim token.");
      if (!record.binding) throw new AgentAuthError(400, "authorization_pending", "The owner has not approved this request.", interval);
      return this.issue(next);
    }
    throw new AgentAuthError(409, "conflict", "The claim changed. Wait before polling again.");
  }
  private checkResource(resource?: string) {
    if (resource !== undefined && resource !== this.resource)
      throw new AgentAuthError(400, "invalid_target", "The requested resource does not match this Ephyra bootstrap API.");
  }
  private async assertion(record: AgentRegistration) {
    return this.signed({ purpose: "agent-renewal-v1", iss: this.origin, aud: this.resource, sub: record.id,
      version: record.version, iat: Math.floor(this.now() / 1000),
      exp: Math.floor(Math.min(record.expiresMs, this.now() + ASSERTION_MS) / 1000) });
  }
  private async signed(payload: Record<string, unknown>) {
    const typ = payload.purpose === "agent-claim-csrf-v1" ? "ephyra-agent-csrf+jwt" : "oauth-id-jag+jwt";
    const input = `${b64url(encoder.encode(JSON.stringify({ alg: "HS256", typ })))}.${b64url(encoder.encode(JSON.stringify(payload)))}`;
    const signature = await crypto.subtle.sign("HMAC", await this.key, encoder.encode(input));
    return `${input}.${b64url(new Uint8Array(signature))}`;
  }
  private async verified(token: string, typ: string): Promise<Record<string, unknown> | null> {
    if (token.length > 8192) return null;
    try {
      const [header, payload, signature, extra] = token.split(".");
      if (!header || !payload || !signature || extra !== undefined) return null;
      const h = JSON.parse(Buffer.from(header, "base64url").toString()) as Record<string, unknown>;
      if (h.alg !== "HS256" || h.typ !== typ) return null;
      const valid = await crypto.subtle.verify("HMAC", await this.key, Buffer.from(signature, "base64url"),
        encoder.encode(`${header}.${payload}`));
      if (!valid) return null;
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
      return typeof claims.exp === "number" && claims.exp > this.now() / 1000 ? claims : null;
    } catch { return null; }
  }
  async exchange(assertion: string, resource?: string) {
    this.checkResource(resource);
    const claims = await this.verified(assertion, "oauth-id-jag+jwt");
    if (!claims || claims.purpose !== "agent-renewal-v1" || claims.iss !== this.origin
      || claims.aud !== this.resource || typeof claims.sub !== "string")
      throw new AgentAuthError(400, "invalid_grant", "This service assertion is invalid or expired. Register again.");
    const record = await this.options.store.get(claims.sub);
    if (!this.active(record) || claims.version !== record.version)
      throw new AgentAuthError(400, "invalid_grant", "This registration was changed, revoked or expired. Register again.");
    return this.issue(record);
  }
  private async issue(record: AgentRegistration) {
    if (record.binding && !await this.bindingIsCurrent(record))
      throw new AgentAuthError(400, "invalid_grant", "The owner changed the repository or workspace. Obtain a new claim.");
    const token = randomToken();
    const expiresMs = Math.min(this.now() + ACCESS_MS, record.expiresMs);
    await this.options.store.putToken({ hash: await sha256b64url(token), registrationId: record.id,
      version: record.version, expiresMs });
    return { access_token: token, token_type: "Bearer", expires_in: Math.floor((expiresMs - this.now()) / 1000),
      scope: record.binding ? record.scopes.join(" ") : "", identity_assertion: await this.assertion(record),
      assertion_expires_in: Math.floor((Math.min(record.expiresMs, this.now() + ASSERTION_MS) - this.now()) / 1000) };
  }
  private async bindingIsCurrent(record: AgentRegistration) {
    if (!record.binding) return false;
    const current = await this.options.currentBinding(record.binding.ownerDid);
    return current !== null && matches(record.binding, current);
  }
  async authenticate(token: string, scope?: AgentScope): Promise<AgentPrincipal | null> {
    if (!secretPattern.test(token)) return null;
    const found = await this.options.store.token(await sha256b64url(token));
    if (!found || found.expiresMs <= this.now()) return null;
    const record = await this.options.store.get(found.registrationId);
    if (!this.active(record) || !record.binding || record.version !== found.version
      || scope !== undefined && !record.scopes.includes(scope)) return null;
    if (!await this.bindingIsCurrent(record)) return null;
    return { ...record.binding, registrationId: record.id, scopes: [...record.scopes] };
  }
  /** Claim one stable setup operation without allowing an agent to reset baseline costs with fresh keys. */
  async setupOperation(token: string, operationKey: string): Promise<string> {
    if (!/^[A-Za-z0-9:._-]{8,160}$/.test(operationKey))
      throw new AgentAuthError(400, "invalid_request", "A stable setup operation key is required.");
    for (let retry = 0; retry < 8; retry++) {
      const principal = await this.authenticate(token, "bootstrap:run");
      if (!principal) throw new AgentAuthError(401, "invalid_token", "Obtain a new owner claim.");
      const record = await this.options.store.get(principal.registrationId);
      if (!record) throw new AgentAuthError(401, "invalid_token", "Obtain a new owner claim.");
      if (record.setupOperationKey) {
        if (record.setupOperationKey === operationKey) return operationKey;
        throw new AgentAuthError(409, "setup_already_claimed", "This grant already has a setup operation. Read its saved result.");
      }
      if (await this.replace(record, { ...record, setupOperationKey: operationKey })) return operationKey;
    }
    throw new AgentAuthError(409, "conflict", "The grant changed. Read its saved setup before retrying.");
  }
  async revoke(token: string) {
    let id: string | undefined;
    let version: number | undefined;
    if (secretPattern.test(token)) {
      const found = await this.options.store.token(await sha256b64url(token));
      if (found) { id = found.registrationId; version = found.version; }
    }
    else {
      const claims = await this.verified(token, "oauth-id-jag+jwt");
      if (claims?.purpose === "agent-renewal-v1" && claims.iss === this.origin
        && claims.aud === this.resource && typeof claims.sub === "string" && typeof claims.version === "number") {
        id = claims.sub; version = claims.version;
      }
    }
    if (id && version !== undefined) await this.revokeId(id, undefined, version);
  }
  private async revokeId(id: string, ownerDid?: string, expectedVersion?: number): Promise<boolean> {
    for (let retry = 0; retry < 8; retry++) {
      const record = await this.options.store.get(id);
      if (!record || ownerDid !== undefined && record.binding?.ownerDid !== ownerDid) return false;
      if (expectedVersion !== undefined && record.version !== expectedVersion) return false;
      if (record.revokedMs !== undefined) return true;
      if (await this.replace(record, { ...record, revokedMs: this.now(), version: record.version + 1 })) return true;
    }
    throw new AgentAuthError(409, "conflict", "The registration changed. Refresh before revoking it again.");
  }
  async revokeOwned(ownerDid: string, id: string) { return this.revokeId(id, ownerDid); }
  async list(ownerDid: string) {
    return (await this.options.store.list(ownerDid)).map((record) => ({ id: record.id,
      repository: record.repository, workspaceId: record.binding!.workspaceId, scopes: record.scopes,
      createdAt: new Date(record.createdMs).toISOString(), expiresAt: new Date(record.expiresMs).toISOString(),
      revokedAt: record.revokedMs !== undefined ? new Date(record.revokedMs).toISOString() : null }));
  }
}

export const createAgentAccess = (options: AgentAccessOptions) => new AgentAccess(options);
