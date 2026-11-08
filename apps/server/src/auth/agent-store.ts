import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

export type AgentScope = "bootstrap:read" | "bootstrap:context" | "bootstrap:run";
export type AgentRepository = { url: string; branch: string };
export type AgentBinding = {
  ownerDid: string;
  workspaceId: string;
  repository: AgentRepository;
  /** Server-owned repository verification timestamp; reconnecting never revives an old grant. */
  repositoryRevision: string;
};
export type AgentPrincipal = AgentBinding & { registrationId: string; scopes: AgentScope[] };

/** No claim secret, human session, assertion or access-token plaintext is stored here. */
export type AgentRegistration = {
  id: string;
  revision: number;
  version: number;
  intendedOwner: string;
  repository: AgentRepository;
  scopes: AgentScope[];
  claimHash: string;
  claimExpiresMs: number;
  createdMs: number;
  expiresMs: number;
  revokedMs?: number;
  binding?: AgentBinding;
  attemptHash?: string;
  attemptId?: string;
  codeHash?: string;
  attemptExpiresMs?: number;
  failedCodes?: number;
  lastPollMs?: number;
  intervalSeconds?: number;
  /** A verified owner approved; an uncertain repository connection must not be repeated blindly. */
  resolvingBinding?: boolean;
  /** One delegated setup run per owner claim; distinct keys cannot repeat baseline spending. */
  setupOperationKey?: string;
};

export type AgentTokenRecord = {
  hash: string;
  registrationId: string;
  version: number;
  expiresMs: number;
};

export interface AgentStore {
  create(record: AgentRegistration): Promise<void>;
  get(id: string): Promise<AgentRegistration | null>;
  byClaim(hash: string): Promise<AgentRegistration | null>;
  byAttempt(hash: string): Promise<AgentRegistration | null>;
  /** Serializes claim attempts, wrong-code counters, approval and polling across replicas. */
  replace(record: AgentRegistration, expectedRevision: number): Promise<boolean>;
  putToken(record: AgentTokenRecord): Promise<void>;
  token(hash: string): Promise<AgentTokenRecord | null>;
  list(ownerDid: string): Promise<AgentRegistration[]>;
}

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryAgentStore implements AgentStore {
  private registrations = new Map<string, AgentRegistration>();
  private tokens = new Map<string, AgentTokenRecord>();

  async create(record: AgentRegistration) {
    if (this.registrations.has(record.id)) throw new Error("Agent registration already exists.");
    this.registrations.set(record.id, copy(record));
  }
  async get(id: string) { return copy(this.registrations.get(id) ?? null); }
  async byClaim(hash: string) {
    return copy([...this.registrations.values()].find((r) => r.claimHash === hash) ?? null);
  }
  async byAttempt(hash: string) {
    return copy([...this.registrations.values()].find((r) => r.attemptHash === hash) ?? null);
  }
  async replace(record: AgentRegistration, expectedRevision: number) {
    const current = this.registrations.get(record.id);
    if (!current || current.revision !== expectedRevision || record.revision !== expectedRevision + 1) return false;
    this.registrations.set(record.id, copy(record));
    return true;
  }
  async putToken(record: AgentTokenRecord) { this.tokens.set(record.hash, copy(record)); }
  async token(hash: string) { return copy(this.tokens.get(hash) ?? null); }
  async list(ownerDid: string) {
    return copy([...this.registrations.values()].reverse().filter((r) => r.binding?.ownerDid === ownerDid).slice(0, 100));
  }
}

export class ConvexAgentStore implements AgentStore {
  constructor(private readonly client: ConvexHttpClient, private readonly secret: string) {}
  async create(record: AgentRegistration) {
    await this.client.mutation(api.agent_auth.create, { secret: this.secret, json: JSON.stringify(record) });
  }
  async get(id: string) {
    const json = await this.client.query(api.agent_auth.get, { secret: this.secret, id });
    return json ? JSON.parse(json) as AgentRegistration : null;
  }
  async byClaim(hash: string) {
    const json = await this.client.query(api.agent_auth.byClaim, { secret: this.secret, hash });
    return json ? JSON.parse(json) as AgentRegistration : null;
  }
  async byAttempt(hash: string) {
    const json = await this.client.query(api.agent_auth.byAttempt, { secret: this.secret, hash });
    return json ? JSON.parse(json) as AgentRegistration : null;
  }
  async replace(record: AgentRegistration, expectedRevision: number) {
    return this.client.mutation(api.agent_auth.replace, {
      secret: this.secret, json: JSON.stringify(record), expectedRevision,
    });
  }
  async putToken(record: AgentTokenRecord) {
    await this.client.mutation(api.agent_auth.putToken, { secret: this.secret, ...record });
  }
  async token(hash: string) {
    const value = await this.client.query(api.agent_auth.token, { secret: this.secret, hash });
    return value ? { hash: value.hash, registrationId: value.registrationId,
      version: value.version, expiresMs: value.expiresMs } : null;
  }
  async list(ownerDid: string) {
    const values = await this.client.query(api.agent_auth.list, { secret: this.secret, ownerDid });
    return values.map((json) => JSON.parse(json) as AgentRegistration);
  }
}
