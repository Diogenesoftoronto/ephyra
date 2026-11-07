// Storage for sign-in: pending logins, sessions, and CLI grants. Secrets are sealed before they reach a store;
// tokens are stored only as SHA-256 hashes.
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

export type LoginTx = {
  state: string;
  verifier: string;
  /** SHA-256 of the browser-binding cookie set at /auth/login (login CSRF guard). */
  browserHash: string;
  /** Present when the login was started by `ephyra login`: SHA-256 of the CLI's secret. */
  cliChallenge?: string;
  createdMs: number;
};

export type SessionRecord = {
  sessionHash: string;
  did: string;
  handle?: string;
  /** Sealed { refreshToken, privateJwk, publicJwk, scope }. */
  sealed: string;
  /** Incremented on every refresh-token rotation (compare-and-swap). */
  version: number;
  createdMs: number;
  expiresMs: number;
};

export type CliGrant = {
  challenge: string;
  /** Sealed session token, released once to the CLI that knows the challenge's preimage. */
  sealedToken: string;
  csrf: string;
  approved: boolean;
  createdMs: number;
};

export interface AuthStore {
  putTx(tx: LoginTx): Promise<void>;
  /** Returns and deletes the transaction (single use). */
  takeTx(state: string): Promise<LoginTx | null>;
  putSession(s: SessionRecord): Promise<void>;
  getSession(sessionHash: string): Promise<SessionRecord | null>;
  /** Latest unexpired session for a DID (used to fund hosted model calls). */
  latestSessionFor(did: string, nowMs: number): Promise<SessionRecord | null>;
  /** CAS on `version`; false when another writer rotated first. */
  updateSealed(sessionHash: string, expectedVersion: number, sealed: string): Promise<boolean>;
  deleteSession(sessionHash: string): Promise<void>;
  putGrant(g: CliGrant): Promise<void>;
  getGrant(challenge: string): Promise<CliGrant | null>;
  approveGrant(challenge: string, csrf: string): Promise<boolean>;
  /** Returns and deletes an approved grant (single use); null if missing or not approved. */
  takeApprovedGrant(challenge: string): Promise<CliGrant | null>;
}

export class MemoryAuthStore implements AuthStore {
  private txs = new Map<string, LoginTx>();
  private sessions = new Map<string, SessionRecord>();
  private grants = new Map<string, CliGrant>();

  async putTx(tx: LoginTx) { this.txs.set(tx.state, { ...tx }); }
  async takeTx(state: string) { const tx = this.txs.get(state) ?? null; this.txs.delete(state); return tx; }
  async putSession(s: SessionRecord) { this.sessions.set(s.sessionHash, { ...s }); }
  async getSession(h: string) { const s = this.sessions.get(h); return s ? { ...s } : null; }
  async latestSessionFor(did: string, nowMs: number) {
    const live = [...this.sessions.values()].filter((s) => s.did === did && s.expiresMs > nowMs);
    live.sort((a, b) => b.createdMs - a.createdMs);
    return live[0] ? { ...live[0] } : null;
  }
  async updateSealed(h: string, expectedVersion: number, sealed: string) {
    const s = this.sessions.get(h);
    if (!s || s.version !== expectedVersion) return false;
    s.sealed = sealed;
    s.version += 1;
    return true;
  }
  async deleteSession(h: string) { this.sessions.delete(h); }
  async putGrant(g: CliGrant) { this.grants.set(g.challenge, { ...g }); }
  async getGrant(c: string) { const g = this.grants.get(c); return g ? { ...g } : null; }
  async approveGrant(c: string, csrf: string) {
    const g = this.grants.get(c);
    if (!g || g.csrf !== csrf) return false;
    g.approved = true;
    return true;
  }
  async takeApprovedGrant(c: string) {
    const g = this.grants.get(c);
    if (!g?.approved) return null;
    this.grants.delete(c);
    return { ...g };
  }
}

export class ConvexAuthStore implements AuthStore {
  constructor(private readonly client: ConvexHttpClient, private readonly secret: string) {}
  private get s() { return this.secret; }

  async putTx(tx: LoginTx) { await this.client.mutation(api.auth.putTx, { secret: this.s, state: tx.state, json: JSON.stringify(tx) }); }
  async takeTx(state: string) {
    const json = await this.client.mutation(api.auth.takeTx, { secret: this.s, state });
    return json ? (JSON.parse(json) as LoginTx) : null;
  }
  async putSession(r: SessionRecord) {
    await this.client.mutation(api.auth.putSession, {
      secret: this.s, sessionHash: r.sessionHash, did: r.did, json: JSON.stringify(r), createdMs: r.createdMs, expiresMs: r.expiresMs,
    });
  }
  async getSession(sessionHash: string) {
    const json = await this.client.query(api.auth.getSession, { secret: this.s, sessionHash });
    return json ? (JSON.parse(json) as SessionRecord) : null;
  }
  async latestSessionFor(did: string, nowMs: number) {
    const json = await this.client.query(api.auth.latestSessionFor, { secret: this.s, did, nowMs });
    return json ? (JSON.parse(json) as SessionRecord) : null;
  }
  async updateSealed(sessionHash: string, expectedVersion: number, sealed: string) {
    return this.client.mutation(api.auth.updateSealed, { secret: this.s, sessionHash, expectedVersion, sealed });
  }
  async deleteSession(sessionHash: string) { await this.client.mutation(api.auth.deleteSession, { secret: this.s, sessionHash }); }
  async putGrant(g: CliGrant) { await this.client.mutation(api.auth.putGrant, { secret: this.s, challenge: g.challenge, json: JSON.stringify(g) }); }
  async getGrant(challenge: string) {
    const json = await this.client.query(api.auth.getGrant, { secret: this.s, challenge });
    return json ? (JSON.parse(json) as CliGrant) : null;
  }
  async approveGrant(challenge: string, csrf: string) {
    return this.client.mutation(api.auth.approveGrant, { secret: this.s, challenge, csrf });
  }
  async takeApprovedGrant(challenge: string) {
    const json = await this.client.mutation(api.auth.takeApprovedGrant, { secret: this.s, challenge });
    return json ? (JSON.parse(json) as CliGrant) : null;
  }
}
