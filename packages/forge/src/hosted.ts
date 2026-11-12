// Hosted pull requests: GitHub (and GitHub Enterprise), GitLab merge requests, Forgejo/Gitea pull requests.
// The head branch moves by a conditional Git push; the proposal is created over the forge's REST API. A token goes only
// in the Authorization header. An ambiguous write is recorded for reconciliation and never retried blindly.
// Codeberg is refused: its terms forbid AI-generated contributions.
import {
  ReconciliationRequired, Unverified, type ForgeAdapter, type ForgeCapabilities, type ForgeEvent,
  type LandingMode, type LandingPlan, type LandingReceipt, type OperationLedger, type Trail,
} from "@ephyra/core";
import { BaseMoved, caps, digest } from "./common";
import { boundedCommandRunner, type CommandRunner } from "./command";
import { PlainGitAdapter } from "./plain-git";
import { RemoteGitAdapter } from "./remote-git";

export type HostedProvider = "github" | "gitlab" | "forgejo";
export type HostedPullOptions = {
  provider: HostedProvider;
  /** API root: https://api.github.com, https://gitlab.com/api/v4, https://<forgejo>/api/v1. GitHub Enterprise allowed. */
  apiBase: string;
  /** "owner/name" (GitHub, Forgejo) or the full project path (GitLab, may contain subgroups). */
  repository: string;
  baseBranch: string;
  /** Called per request; never stored, logged or put in a URL. */
  token: () => Promise<string>;
  fetch?: typeof fetch;
  repoDir: string;
  /** HTTPS clone URL without credentials. */
  remote: string;
  run?: CommandRunner;
  ledger: OperationLedger;
  scope: string;
  authorize: () => Promise<void>;
};

const MAX_BODY = 2_000_000;
const TIMEOUT_MS = 15_000;
const oid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
const TRAIL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const isCodeberg = (host: string) => host === "codeberg.org" || host.endsWith(".codeberg.org");

/** The branch a trail's proposal lives on. Throws for an id that would not make a safe, single-segment branch name. */
export function proposalBranch(trailId: string, prefix = ""): string {
  if (!TRAIL_ID.test(trailId) || trailId.includes("..") || trailId.endsWith(".lock") || trailId.endsWith("."))
    throw new Error("invalid trail id for a proposal branch");
  return `ephyra/${prefix}${trailId}`;
}

/** Which hosted API a clone URL belongs to. Null for anything Ephyra will not land on, including Codeberg. */
export function hostedProviderFor(
  cloneUrl: string,
  options: { gitlabHosts?: string[]; githubEnterpriseHosts?: string[] } = {},
): { provider: HostedProvider; apiBase: string; repository: string } | null {
  let url: URL;
  try { url = new URL(cloneUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (isCodeberg(host)) return null;
  const segments = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === ".." || !/^[A-Za-z0-9._-]+$/.test(s))) return null;
  const repository = segments.join("/");
  if (host === "github.com" || options.githubEnterpriseHosts?.includes(host)) {
    if (segments.length !== 2) return null;
    return { provider: "github", apiBase: host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`, repository };
  }
  if (host === "gitlab.com" || options.gitlabHosts?.includes(host)) {
    if (segments.length < 2) return null;
    return { provider: "gitlab", apiBase: `https://${host}/api/v4`, repository };
  }
  if (segments.length !== 2) return null;
  return { provider: "forgejo", apiBase: `https://${host}/api/v1`, repository };
}

type Proposal = { number: string; url: string; state: "open" | "closed" | "merged"; head: string; headSha: string | null;
  mergeSha: string | null; updatedAt: string };
type Rejected = { rejected: "base_moved"; target: string } | { refused: number; target: string };
type Cursor = { seen: string[] };

class HttpFailure extends Error {
  constructor(readonly status: number | null, readonly definite: boolean, message: string) { super(message); this.name = "HttpFailure"; }
}

export class HostedPullAdapter implements ForgeAdapter {
  readonly name: HostedProvider;
  private readonly run: CommandRunner;
  private readonly remoteGit: RemoteGitAdapter;
  private readonly api: URL;

  constructor(private readonly options: HostedPullOptions) {
    this.name = options.provider;
    this.api = new URL(options.apiBase);
    const remote = new URL(options.remote);
    if (this.api.protocol !== "https:" || remote.protocol !== "https:") throw new Error("hosted forges need HTTPS");
    if (isCodeberg(this.api.hostname) || isCodeberg(remote.hostname))
      throw new Error("Codeberg forbids AI-generated contributions; Ephyra does not land there");
    if (this.api.username || this.api.password || remote.username || remote.password) throw new Error("credentials stay out of URLs");
    if (!options.scope || !options.repository || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.baseBranch))
      throw new Error("hosted pull adapter needs a scope, repository and base branch");
    const parts = options.repository.split("/");
    if (parts.some((p) => !p || p === "." || p === "..") || (options.provider !== "gitlab" && parts.length !== 2))
      throw new Error("invalid repository path");
    this.run = options.run ?? boundedCommandRunner();
    this.remoteGit = new RemoteGitAdapter(options.repoDir, {
      remote: options.remote, scope: options.scope, ledger: options.ledger, authorize: options.authorize, run: this.run,
    });
  }

  async capabilities(): Promise<ForgeCapabilities> {
    return { ...caps(this.name, ["trail_ref", "pull_request", "auto_land"], true), proposals: true, events: true, ci: true,
      customRefs: "unknown" };
  }

  // ───────────── landing ─────────────

  async prepareLanding(trail: Trail, mode: LandingMode, base: string, proof: string): Promise<LandingPlan> {
    const plain = new PlainGitAdapter(this.options.repoDir, this.run);
    if (mode === "trail_ref" || mode === "auto_land") return plain.prepareLanding(trail, mode, base, proof);
    if (mode !== "pull_request") throw new Unverified(mode);
    await this.options.authorize();
    proposalBranch(trail.id);
    const plan = await plain.prepareLanding(trail, "auto_land", base, proof);
    return { ...plan, mode, target: `refs/heads/${this.options.baseBranch}` };
  }

  async land(plan: LandingPlan, auth: string, key: string): Promise<LandingReceipt> {
    if (plan.mode === "trail_ref" || plan.mode === "auto_land") return this.remoteGit.land(plan, auth, key);
    if (plan.mode !== "pull_request") throw new Unverified(plan.mode);
    await this.options.authorize();
    if (!auth || !key || !oid(plan.expectedBase) || !oid(plan.head) || plan.target !== `refs/heads/${this.options.baseBranch}`)
      throw new Error("invalid authorized pull request");
    const head = proposalBranch(plan.trailId);
    const replay = await this.begin(key, ["land", plan, auth]);
    if (replay) return replay;
    if (await this.remoteGit.readRemoteRef(plan.target) !== plan.expectedBase) {
      await this.options.ledger.complete(key, { rejected: "base_moved", target: plan.target } satisfies Rejected);
      throw new BaseMoved(plan.target);
    }
    try {
      await this.pushBranch(head, plan.head, key);
      const message = plan.commitMessage?.trim() || `Ephyra repair ${plan.trailId}`;
      const title = message.split("\n")[0]!.slice(0, 250);
      const body = [
        message, "", `Ephyra trail: ${plan.trailId}`, `Proof: ${plan.proofDigest}`,
        "", "Opened by Ephyra. Review it like any other change; nothing merges without the forge's own rules.",
      ].join("\n");
      const proposal = await this.findOpen(head) ?? await this.create(head, title, body);
      if (proposal.state !== "open" || proposal.head !== head) throw new Unverified("pull request readback");
      const receipt: LandingReceipt = {
        mode: "pull_request", target: plan.target, oldOid: plan.expectedBase, newOid: plan.head, authorizationId: auth,
        proofDigest: plan.proofDigest, externalId: proposal.number, externalRevision: proposal.url, at: new Date().toISOString(),
      };
      await this.options.ledger.complete(key, receipt);
      return receipt;
    } catch (error) {
      if (error instanceof HttpFailure && error.definite) {
        await this.options.ledger.complete(key, { refused: error.status ?? 400, target: plan.target } satisfies Rejected);
        throw new Unverified(`${this.name} refused the pull request (${error.status})`);
      }
      if (error instanceof Unverified && /rate limited/.test(error.message)) throw error;
      await this.options.ledger.markAmbiguous(key, `${this.name} pull request outcome requires reconciliation`);
      throw new ReconciliationRequired(key, `${this.name} pull request outcome requires reconciliation`);
    }
  }

  async revert(receipt: LandingReceipt, key: string): Promise<LandingReceipt> {
    if (receipt.mode === "trail_ref" || receipt.mode === "auto_land") return this.remoteGit.revert(receipt, key);
    if (receipt.mode !== "pull_request" || !receipt.externalId || !key) throw new Unverified("pull request receipt");
    await this.options.authorize();
    const replay = await this.begin(key, ["revert", receipt]);
    if (replay) return replay;
    try {
      const current = await this.get(receipt.externalId);
      if (current.state === "open") {
        const closed = await this.close(receipt.externalId);
        if (closed.state !== "closed") throw new Unverified("pull request close readback");
        const done = { ...receipt, externalVersion: "closed", at: new Date().toISOString() };
        await this.options.ledger.complete(key, done);
        return done;
      }
      if (current.state === "closed") {
        const done = { ...receipt, externalVersion: "closed", at: new Date().toISOString() };
        await this.options.ledger.complete(key, done);
        return done;
      }
      if (!oid(current.mergeSha)) throw new Unverified("merged pull request has no merge commit");
      const trailId = /^ephyra\/(.+)$/.exec(current.head)?.[1] ?? "";
      const head = proposalBranch(trailId, "revert-");
      const base = await this.remoteGit.readRemoteRef(`refs/heads/${this.options.baseBranch}`);
      if (!oid(base)) throw new Unverified("base branch for revert");
      await this.git(["fetch", "--no-tags", "--", this.options.remote, `+refs/heads/${this.options.baseBranch}`]);
      const parent = await this.git(["rev-parse", `${current.mergeSha}^1`]);
      const merged = await this.run(["git", "merge-tree", "--write-tree", `--merge-base=${current.mergeSha}`, base, parent],
        this.options.repoDir);
      if (merged.code !== 0) throw new Unverified("revert conflicts with later changes; a human has to resolve it");
      const tree = merged.stdout.trim().split("\n")[0]!;
      const commit = await this.git(["-c", "user.name=ephyra", "-c", "user.email=ephyra@localhost", "commit-tree", tree, "-p", base,
        "-m", `Revert ${current.url}\n\nEphyra-Revert-Of: ${current.mergeSha}`]);
      if (!oid(commit)) throw new Unverified("revert commit");
      await this.pushBranch(head, commit, key);
      const proposal = await this.findOpen(head)
        ?? await this.create(head, `Revert: ${current.url}`.slice(0, 250), `Reverts ${current.url} (${current.mergeSha}).\n\nOpened by Ephyra.`);
      const done: LandingReceipt = { ...receipt, oldOid: base, newOid: commit, externalId: proposal.number,
        externalRevision: proposal.url, externalVersion: `revert-of:${receipt.externalId}`, at: new Date().toISOString() };
      await this.options.ledger.complete(key, done);
      return done;
    } catch (error) {
      if (error instanceof Unverified) {
        await this.options.ledger.markAmbiguous(key, error.message);
        throw error;
      }
      await this.options.ledger.markAmbiguous(key, `${this.name} revert outcome requires reconciliation`);
      throw new ReconciliationRequired(key, `${this.name} revert outcome requires reconciliation`);
    }
  }

  // ───────────── events ─────────────

  async *events(cursor: string | null, signal?: AbortSignal): AsyncIterable<ForgeEvent> {
    const state = decodeCursor(cursor);
    const seen = new Set(state.seen);
    for (const proposal of await this.recent(signal)) {
      if (!proposal.head.startsWith("ephyra/")) continue;
      const found: Omit<ForgeEvent, "cursor" | "workspace" | "repo" | "adapter" | "payloadDigest">[] = [];
      found.push({ sourceId: `proposal:${proposal.number}:${proposal.state}`, occurredAt: proposal.updatedAt,
        kind: proposal.state === "open" ? "proposal.opened" : "proposal.updated", objectId: proposal.number,
        revision: proposal.state, ref: `refs/heads/${proposal.head}`, commit: proposal.mergeSha ?? proposal.headSha ?? undefined,
        actor: this.name });
      for (const review of await this.reviews(proposal, signal)) found.push(review);
      for (const comment of await this.comments(proposal, signal)) found.push(comment);
      const ci = proposal.headSha ? await this.ci(proposal, signal) : null;
      if (ci) found.push(ci);
      for (const event of found) {
        if (seen.has(event.sourceId)) continue;
        seen.add(event.sourceId);
        state.seen.push(event.sourceId);
        if (state.seen.length > 1000) state.seen.splice(0, state.seen.length - 1000);
        yield { ...event, workspace: this.options.scope, repo: this.options.repository, adapter: this.name,
          cursor: encodeCursor(state), payloadDigest: digest(JSON.stringify(event)) };
      }
    }
  }

  // ───────────── provider calls ─────────────

  private repoPath(): string {
    if (this.name === "gitlab") return `/projects/${encodeURIComponent(this.options.repository)}`;
    const [owner, name] = this.options.repository.split("/");
    return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
  }

  private async findOpen(head: string): Promise<Proposal | null> {
    const q = new URLSearchParams();
    if (this.name === "github") { q.set("state", "open"); q.set("head", `${this.options.repository.split("/")[0]}:${head}`); }
    else if (this.name === "gitlab") { q.set("state", "opened"); q.set("source_branch", head); q.set("target_branch", this.options.baseBranch); }
    else { q.set("state", "open"); q.set("limit", "50"); }
    const list = await this.request("GET", `${this.repoPath()}/${this.name === "gitlab" ? "merge_requests" : "pulls"}?${q}`);
    if (!Array.isArray(list)) throw new Unverified(`${this.name} pull request list`);
    return list.map((item) => this.proposal(item)).find((p) => p.head === head && p.state === "open") ?? null;
  }

  private async create(head: string, title: string, body: string): Promise<Proposal> {
    const created = this.name === "gitlab"
      ? await this.request("POST", `${this.repoPath()}/merge_requests`,
        { source_branch: head, target_branch: this.options.baseBranch, title, description: body, remove_source_branch: true })
      : await this.request("POST", `${this.repoPath()}/pulls`, { head, base: this.options.baseBranch, title, body });
    return this.proposal(created);
  }

  private async get(number: string): Promise<Proposal> {
    if (!/^\d{1,12}$/.test(number)) throw new Unverified("pull request number");
    return this.proposal(await this.request("GET", `${this.repoPath()}/${this.name === "gitlab" ? "merge_requests" : "pulls"}/${number}`));
  }

  private async close(number: string): Promise<Proposal> {
    return this.proposal(this.name === "gitlab"
      ? await this.request("PUT", `${this.repoPath()}/merge_requests/${number}`, { state_event: "close" })
      : await this.request("PATCH", `${this.repoPath()}/pulls/${number}`, { state: "closed" }));
  }

  private async recent(signal?: AbortSignal): Promise<Proposal[]> {
    const path = this.name === "github" ? "/pulls?state=all&sort=updated&direction=desc&per_page=20"
      : this.name === "gitlab" ? "/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=20"
        : "/pulls?state=all&sort=recentupdate&limit=20";
    const list = await this.request("GET", `${this.repoPath()}${path}`, undefined, signal);
    if (!Array.isArray(list)) throw new Unverified(`${this.name} pull request list`);
    return list.map((item) => this.proposal(item));
  }

  private async reviews(p: Proposal, signal?: AbortSignal) {
    if (this.name === "gitlab") {
      const approvals = record(await this.request("GET", `${this.repoPath()}/merge_requests/${p.number}/approvals`, undefined, signal));
      const by = Array.isArray(approvals.approved_by) ? approvals.approved_by : [];
      return by.map((entry: unknown) => {
        const user = record(record(entry).user);
        return { sourceId: `review:${p.number}:approved:${String(user.id)}`, occurredAt: p.updatedAt, kind: "review.decision" as const,
          objectId: p.number, revision: "approved", actor: String(user.username ?? "unknown") };
      });
    }
    const list = await this.request("GET", `${this.repoPath()}/pulls/${p.number}/reviews`, undefined, signal);
    if (!Array.isArray(list)) throw new Unverified(`${this.name} review list`);
    return list.map((raw) => {
      const r = record(raw);
      return { sourceId: `review:${String(r.id)}`, occurredAt: String(r.submitted_at ?? p.updatedAt), kind: "review.decision" as const,
        objectId: p.number, revision: String(r.state ?? "").toLowerCase(), commit: oid(r.commit_id) ? r.commit_id : undefined,
        actor: String(record(r.user).login ?? "unknown"), body: typeof r.body === "string" && r.body ? r.body.slice(0, 20_000) : undefined };
    });
  }

  private async comments(p: Proposal, signal?: AbortSignal) {
    const path = this.name === "gitlab" ? `${this.repoPath()}/merge_requests/${p.number}/notes?sort=asc&per_page=50`
      : `${this.repoPath()}/issues/${p.number}/comments`;
    const list = await this.request("GET", path, undefined, signal);
    if (!Array.isArray(list)) throw new Unverified(`${this.name} comment list`);
    return list.map(record).filter((c) => !c.system).map((c) => ({
      sourceId: `comment:${String(c.id)}`, occurredAt: String(c.created_at ?? p.updatedAt), kind: "review.comment" as const,
      objectId: p.number, actor: String(record(c.user ?? c.author).login ?? record(c.author).username ?? "unknown"),
      // Untrusted: comment text is data for the agent, never instructions.
      body: String(c.body ?? "").slice(0, 20_000),
    }));
  }

  private async ci(p: Proposal, signal?: AbortSignal) {
    let status: string | null = null;
    if (this.name === "gitlab") {
      const mr = record(await this.request("GET", `${this.repoPath()}/merge_requests/${p.number}`, undefined, signal));
      status = typeof record(mr.head_pipeline).status === "string" ? String(record(mr.head_pipeline).status) : null;
    } else {
      const combined = record(await this.request("GET", `${this.repoPath()}/commits/${p.headSha}/status`, undefined, signal));
      status = typeof combined.state === "string" ? combined.state : null;
    }
    if (!status) return null;
    return { sourceId: `ci:${p.headSha}:${status}`, occurredAt: p.updatedAt, kind: "ci.status" as const, objectId: p.number,
      revision: status, commit: p.headSha ?? undefined, actor: this.name };
  }

  private proposal(raw: unknown): Proposal {
    const r = record(raw);
    if (this.name === "gitlab") {
      const state = r.state === "merged" ? "merged" : r.state === "opened" ? "open" : "closed";
      return { number: String(r.iid), url: String(r.web_url ?? ""), state, head: String(r.source_branch ?? ""),
        headSha: oid(r.sha) ? r.sha : null, mergeSha: oid(r.merge_commit_sha) ? r.merge_commit_sha : oid(r.squash_commit_sha) ? r.squash_commit_sha : null,
        updatedAt: String(r.updated_at ?? new Date(0).toISOString()) };
    }
    const head = record(r.head);
    const merged = r.merged === true || typeof r.merged_at === "string" && r.merged_at !== "";
    return { number: String(r.number), url: String(r.html_url ?? ""), state: merged ? "merged" : r.state === "open" ? "open" : "closed",
      head: String(head.ref ?? ""), headSha: oid(head.sha) ? head.sha : null,
      mergeSha: merged && oid(r.merge_commit_sha) ? r.merge_commit_sha : null, updatedAt: String(r.updated_at ?? new Date(0).toISOString()) };
  }

  // ───────────── transport ─────────────

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!path.startsWith("/")) throw new Error("API path must be relative");
    let url = new URL(`${this.api.pathname.replace(/\/$/, "")}${path}`, this.api.origin);
    const token = await this.options.token();
    const header = this.name === "forgejo" ? `token ${token}` : `Bearer ${token}`;
    for (let hop = 0; hop < 2; hop++) {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(url, {
          method, redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { Authorization: header, Accept: "application/json", "User-Agent": "ephyra",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(this.name === "github" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new HttpFailure(null, false, `${this.name} API unreachable`);
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        const next = location ? new URL(location, url) : null;
        if (!next || next.origin !== this.api.origin) throw new Unverified(`${this.name} API redirected to another host`);
        url = next;
        continue;
      }
      const text = await bounded(response);
      const limited = response.status === 429
        || response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text));
      if (limited) {
        const reset = response.headers.get("x-ratelimit-reset") ?? response.headers.get("ratelimit-reset");
        const retry = response.headers.get("retry-after");
        const at = reset && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000).toISOString()
          : retry && /^\d+$/.test(retry) ? new Date(Date.now() + Number(retry) * 1000).toISOString() : "unknown";
        throw new Unverified(`${this.name} API rate limited until ${at}`);
      }
      if (response.status >= 500) throw new HttpFailure(response.status, false, `${this.name} API failed (${response.status})`);
      if (response.status >= 400) throw new HttpFailure(response.status, true, `${this.name} API refused (${response.status})`);
      if (!text) return null;
      try { return JSON.parse(text); } catch { throw new Unverified(`${this.name} API response`); }
    }
    throw new Unverified(`${this.name} API redirected too many times`);
  }

  private async pushBranch(head: string, value: string, key: string): Promise<void> {
    const target = `refs/heads/${head}`;
    const current = await this.remoteGit.readRemoteRef(target);
    if (current === value) return;
    await this.options.authorize();
    const pushed = await this.run(["git", "push", "--porcelain", "--no-verify", `--force-with-lease=${target}:${current ?? ""}`,
      "--", this.options.remote, `${value}:${target}`], this.options.repoDir);
    if (pushed.code !== 0 || await this.remoteGit.readRemoteRef(target) !== value) {
      await this.options.ledger.markAmbiguous(key, "proposal branch push outcome requires reconciliation");
      throw new ReconciliationRequired(key, "proposal branch push outcome requires reconciliation");
    }
  }

  private async git(args: string[]): Promise<string> {
    const result = await this.run(["git", ...args], this.options.repoDir);
    if (result.code !== 0) throw new Unverified("local Git operation failed");
    return result.stdout.trim();
  }

  private async begin(key: string, plan: unknown): Promise<LandingReceipt | null> {
    const claim = await this.options.ledger.begin(key,
      digest(JSON.stringify([this.options.scope, this.name, this.options.apiBase, this.options.repository, plan])));
    if (claim.fresh) return null;
    if (claim.record.status !== "done") throw new ReconciliationRequired(key, `${this.name} operation requires reconciliation`);
    const result = claim.record.result as LandingReceipt | Rejected;
    if ("rejected" in result) throw new BaseMoved(result.target);
    if ("refused" in result) throw new Unverified(`${this.name} refused the pull request (${result.refused})`);
    return result;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function bounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new Unverified("forge API response too large"); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(cursor: string | null): Cursor {
  if (!cursor) return { seen: [] };
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(value?.seen) && value.seen.every((s: unknown) => typeof s === "string")) return { seen: value.seen.slice(-1000) };
  } catch { /* fall through */ }
  throw new Error("invalid hosted forge cursor");
}
