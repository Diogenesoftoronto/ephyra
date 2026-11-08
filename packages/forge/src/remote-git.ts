import {
  ReconciliationRequired, Unverified, type ForgeAdapter, type ForgeCapabilities, type ForgeEvent,
  type LandingMode, type LandingPlan, type LandingReceipt, type OperationLedger, type Trail,
} from "@ephyra/core";
import { BaseMoved, caps, digest } from "./common";
import { boundedCommandRunner, type CommandRunner } from "./command";
import { PlainGitAdapter } from "./plain-git";

export type RemoteGitOptions = {
  /** A fixed, account-authorized remote. Never a model-selected URL or a credential-bearing URL. */
  remote: string;
  scope: string;
  ledger: OperationLedger;
  /** Recheck current workspace ownership and write authority, including completed receipt reuse. */
  authorize: () => Promise<void>;
  /** Hosted callers inject the constrained, DNS-pinned, credential-scoped Git transport. */
  run?: CommandRunner;
};

const oid = (value: string) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
const branch = (value: string) => /^refs\/heads\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)
  && !value.includes("..") && !value.includes("//") && !value.endsWith("/") && !value.endsWith(".lock");
type Rejected = { rejected: "base_moved"; target: string };

/** Remote writes are conditional pushes followed by an authoritative ref read, never local mirror updates. */
export class RemoteGitAdapter implements ForgeAdapter {
  readonly name = "plain-git";
  private readonly run: CommandRunner;
  constructor(private readonly repoDir: string, private readonly options: RemoteGitOptions) {
    if (!options.scope || !options.remote || /[\x00-\x20]/.test(options.remote) || options.remote.startsWith("-")) {
      throw new Error("fixed remote and scope required");
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(options.remote)) {
      const url = new URL(options.remote);
      if (url.username || url.password) throw new Error("remote credentials must stay in the transport");
    }
    this.run = options.run ?? boundedCommandRunner();
  }

  async capabilities(): Promise<ForgeCapabilities> {
    return { ...caps(this.name, ["trail_ref", "auto_land"], true), events: false, customRefs: "unknown" };
  }

  async *events(_cursor: string | null): AsyncIterable<ForgeEvent> {
    throw new Unverified("remote Git event transport");
  }

  async prepareLanding(trail: Trail, mode: LandingMode, base: string, proof: string): Promise<LandingPlan> {
    await this.options.authorize();
    return new PlainGitAdapter(this.repoDir, this.run).prepareLanding(trail, mode, base, proof);
  }

  async readRemoteRef(target: string): Promise<string | null> {
    if (!branch(target)) throw new Error("invalid remote branch");
    await this.options.authorize();
    return this.readRef(target);
  }

  private async local(args: string[]): Promise<string> {
    const result = await this.run(["git", ...args], this.repoDir);
    if (result.code) throw new Unverified("local Git object operation failed");
    return result.stdout.trim();
  }

  private async readRef(target: string): Promise<string | null> {
    const result = await this.run(["git", "ls-remote", "--refs", "--exit-code", "--", this.options.remote, target], this.repoDir);
    if (result.code === 2 && !result.stdout.trim()) return null;
    if (result.code !== 0) throw new Unverified("remote Git reference unavailable");
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Unverified("remote Git reference response");
    const [value, ref, extra] = lines[0]!.split(/\s+/);
    if (!value || !oid(value) || ref !== target || extra) throw new Unverified("remote Git reference response");
    return value;
  }

  private validate(target: string, value: string, expected: string | null): void {
    if (!branch(target) || !oid(value) || expected !== null && (!oid(expected) || expected.length !== value.length)) {
      throw new Error("invalid conditional Git write");
    }
  }

  private async begin(key: string, plan: unknown): Promise<LandingReceipt | null> {
    if (!key) throw new Error("operation key required");
    const claim = await this.options.ledger.begin(key, digest(JSON.stringify([this.options.scope, this.options.remote, plan])));
    if (claim.fresh) return null;
    if (claim.record.status !== "done") throw new ReconciliationRequired(key, "remote Git operation requires reconciliation");
    const result = claim.record.result as LandingReceipt | Rejected;
    if ("rejected" in result) throw new BaseMoved(result.target);
    return result;
  }

  private async push(target: string, value: string | null, expected: string | null, key: string): Promise<void> {
    const before = await this.readRef(target);
    if (before !== expected) {
      await this.options.ledger.complete(key, { rejected: "base_moved", target } satisfies Rejected);
      throw new BaseMoved(target);
    }
    await this.options.authorize();
    try {
      const result = await this.run([
        "git", "push", "--porcelain", "--no-verify", `--force-with-lease=${target}:${expected ?? ""}`,
        "--", this.options.remote, `${value ?? ""}:${target}`,
      ], this.repoDir);
      const after = await this.readRef(target);
      if (result.code !== 0 || after !== value) {
        throw new Error("push did not establish the requested remote ref");
      }
    } catch {
      await this.options.ledger.markAmbiguous(key, "remote Git write outcome requires authoritative reconciliation");
      throw new ReconciliationRequired(key, "remote Git write outcome requires authoritative reconciliation");
    }
  }

  async land(plan: LandingPlan, authorizationId: string, key: string): Promise<LandingReceipt> {
    await this.options.authorize();
    if (!authorizationId) throw new Error("authorization required");
    if (plan.mode !== "trail_ref" && plan.mode !== "auto_land") throw new Unverified(plan.mode);
    const target = plan.mode === "trail_ref" ? `refs/heads/ephyra/${plan.trailId}` : plan.target;
    const expected = plan.mode === "trail_ref" ? null : plan.expectedBase;
    this.validate(target, plan.head, expected);
    const message = await this.local(["show", "-s", "--format=%B", plan.head]);
    if (plan.commitMessage !== undefined && message !== plan.commitMessage.trim()) throw new Error("approved commit message changed");
    const replay = await this.begin(key, ["land", plan, authorizationId]);
    if (replay) return replay;
    await this.push(target, plan.head, expected, key);
    const receipt: LandingReceipt = {
      mode: plan.mode, target, oldOid: expected, newOid: plan.head, authorizationId,
      proofDigest: plan.proofDigest, at: new Date().toISOString(),
    };
    await this.options.ledger.complete(key, receipt);
    return receipt;
  }

  async revert(receipt: LandingReceipt, key: string): Promise<LandingReceipt> {
    await this.options.authorize();
    if (!["trail_ref", "auto_land"].includes(receipt.mode)) throw new Unverified(receipt.mode);
    this.validate(receipt.target, receipt.newOid, receipt.oldOid);
    const replay = await this.begin(key, ["revert", receipt]);
    if (replay) return replay;
    let next: string | null = null;
    if (receipt.mode === "auto_land") {
      if (!receipt.oldOid) throw new Unverified("remote landing has no pre-landing commit");
      const tree = await this.local(["rev-parse", `${receipt.oldOid}^{tree}`]);
      next = await this.local([
        "-c", "user.name=ephyra", "-c", "user.email=ephyra@localhost", "commit-tree", tree, "-p", receipt.newOid,
        "-m", `Revert landing ${receipt.newOid}\n\nEphyra-Revert-Of: ${receipt.newOid}`,
      ]);
      if (!oid(next)) throw new Unverified("remote revert commit");
    }
    await this.push(receipt.target, next, receipt.newOid, key);
    const reverted = { ...receipt, oldOid: receipt.newOid, newOid: next ?? "0".repeat(receipt.newOid.length), at: new Date().toISOString() };
    await this.options.ledger.complete(key, reverted);
    return reverted;
  }
}
