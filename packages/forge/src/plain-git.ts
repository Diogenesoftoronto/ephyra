import {
  Unverified,
  ReconciliationRequired,
  type ForgeAdapter,
  type ForgeCapabilities,
  type ForgeEvent,
  type LandingPlan,
  type LandingReceipt,
  type LandingMode,
  type Trail,
  type OperationLedger,
} from "@ephyra/core";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { MemoryOperationLedger } from "./ledger";
import { commandRunner, type CommandRunner } from "./command";
import { BaseMoved, caps, digest } from "./common";
export class PlainGitAdapter implements ForgeAdapter {
  readonly name = "plain-git";
  private readonly locks = new Map<string, Promise<void>>();
  constructor(
    public readonly repoDir: string,
    private readonly run: CommandRunner = commandRunner,
    private readonly workspace = "default",
    private readonly repo = repoDir,
    private readonly ledger: OperationLedger = new MemoryOperationLedger(),
  ) {}
  async capabilities(): Promise<ForgeCapabilities> {
    return caps(this.name, ["trail_ref", "auto_land"], true);
  }
  private async git(...args: string[]) {
    const r = await this.run(["git", ...args], this.repoDir);
    if (r.code) throw new Error(r.stderr || `git exited ${r.code}`);
    return r.stdout.trim();
  }
  async installHook(repoDir = this.repoDir) {
    const result = await this.run(
      ["git", "rev-parse", "--absolute-git-dir"],
      repoDir,
    );
    if (result.code) throw new Error(result.stderr);
    const dir = result.stdout.trim();
    // Python performs JSON escaping; append mode keeps each received update on one line.
    const hook = [
      "#!/bin/sh",
      "exec python3 -c 'import sys,os,json,datetime",
      `p=os.path.join(${JSON.stringify(dir)}, "ephyra-spool.jsonl")`,
      'with open(p,"a") as f:',
      ' for line in sys.stdin:',
      '  old,new,ref=line.split()',
      '  principal=os.getenv("EPHYRA_PRINCIPAL") or os.getenv("GL_USER") or os.getenv("USER") or "unknown"',
      '  item=dict(old=old,new=new,ref=ref,principal=principal,time=datetime.datetime.now(datetime.timezone.utc).isoformat())',
      `  f.write(json.dumps(item)+"\\n")'`,
      "",
    ].join("\n");
    await writeFile(join(dir, "hooks", "post-receive"), hook, { flag: "wx" });
    await chmod(join(dir, "hooks", "post-receive"), 0o755);
  }
  async *events(cursor: string | null): AsyncIterable<ForgeEvent> {
    const dir = await this.git("rev-parse", "--absolute-git-dir");
    let data: Buffer;
    try {
      data = await readFile(join(dir, "ephyra-spool.jsonl"));
    } catch (e: any) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > data.length)
      throw new Error("invalid spool cursor");
    let pos = offset;
    const seen = new Set<string>();
    for (;;) {
      const end = data.indexOf(10, pos);
      if (end < 0) break;
      const line = data.subarray(pos, end).toString();
      pos = end + 1;
      const item = JSON.parse(line);
      const key = `${item.ref}\0${item.new}`;
      if (seen.has(key)) continue;
      seen.add(key);
      yield {
        workspace: this.workspace,
        repo: this.repo,
        adapter: this.name,
        sourceId: key,
        cursor: String(pos),
        occurredAt: item.time,
        kind: "push",
        commit: item.new,
        ref: item.ref,
        actor: item.principal,
        payloadDigest: digest(line),
      };
    }
  }
  async prepareLanding(
    trail: Trail,
    mode: LandingMode,
    expectedBase: string,
    proofDigest: string,
  ): Promise<LandingPlan> {
    if (!trail.head) throw new Error("trail has no head");
    if (mode !== "trail_ref" && mode !== "auto_land")
      throw new Unverified(mode);
    const message = await this.git("show", "-s", "--format=%B", trail.head);
    if (
      !message.includes(`Ephyra-Trail: ${trail.id}`) ||
      !message.includes(`Ephyra-Proof: ${proofDigest}`)
    ) {
      throw new Error(
        "head commit is missing required trail and proof trailers",
      );
    }
    return {
      trailId: trail.id,
      mode,
      target: trail.landing?.target ?? trail.base.ref,
      expectedBase,
      head: trail.head,
      proofDigest,
      commitMessage: message,
    };
  }
  private async serial<T>(target: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(target) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(target, next);
    await prev;
    try {
      return await f();
    } finally {
      release();
      if (this.locks.get(target) === next) this.locks.delete(target);
    }
  }
  async land(
    plan: LandingPlan,
    authorizationId: string,
    idempotencyKey: string,
  ): Promise<LandingReceipt> {
    if (!idempotencyKey || !authorizationId)
      throw new Error("authorization and idempotency key required");
    if (plan.mode !== "trail_ref" && plan.mode !== "auto_land")
      throw new Unverified(plan.mode);
    const target =
      plan.mode === "trail_ref"
        ? `refs/heads/ephyra/${plan.trailId}`
        : plan.target;
    return this.serial(target, async () => {
      const signature = digest(JSON.stringify([plan, authorizationId]));
      const prior = await this.ledger.begin(idempotencyKey, signature);
      if (!prior.fresh) {
        if (prior.record.status === "done")
          return prior.record.result as LandingReceipt;
        throw new ReconciliationRequired(
          idempotencyKey,
          "operation already pending or ambiguous",
        );
      }
      if (plan.mode === "auto_land" && plan.commitMessage !== undefined) {
        const message = await this.git("show", "-s", "--format=%B", plan.head);
        if (message !== plan.commitMessage.trim())
          throw new Error("approved commit message does not match head");
      }
      const old =
        plan.mode === "trail_ref"
          ? "0".repeat(plan.head.length)
          : plan.expectedBase;
      let result;
      try {
        result = await this.run(
          ["git", "update-ref", target, plan.head, old],
          this.repoDir,
        );
      } catch {
        await this.ledger.markAmbiguous(
          idempotencyKey,
          "update-ref outcome unknown",
        );
        throw new ReconciliationRequired(
          idempotencyKey,
          "update-ref outcome unknown",
        );
      }
      if (result.code) {
        const current = await this.run(
          ["git", "rev-parse", "--verify", target],
          this.repoDir,
        );
        if (current.stdout.trim() !== old) throw new BaseMoved(target);
        throw new Error(result.stderr);
      }
      const receipt: LandingReceipt = {
        mode: plan.mode,
        target,
        oldOid: plan.mode === "trail_ref" ? null : old,
        newOid: plan.head,
        authorizationId,
        proofDigest: plan.proofDigest,
        at: new Date().toISOString(),
      };
      await this.ledger.complete(idempotencyKey, receipt);
      return receipt;
    });
  }
  async revert(
    _receipt: LandingReceipt,
    _idempotencyKey: string,
  ): Promise<LandingReceipt> {
    throw new Unverified("git revert commit and durable idempotency");
  }
}
