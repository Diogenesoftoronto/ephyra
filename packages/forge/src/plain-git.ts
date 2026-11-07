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
import {
  readFile,
  writeFile,
  chmod,
  mkdtemp,
  rm,
  open,
  mkdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryOperationLedger } from "./ledger";
import { commandRunner, type CommandRunner } from "./command";
import { BaseMoved, caps, digest } from "./common";
const processLocks = new Map<string, Promise<void>>();

export class PlainGitAdapter implements ForgeAdapter {
  readonly name = "plain-git";
  private readonly locks = processLocks;
  constructor(
    public readonly repoDir: string,
    private readonly run: CommandRunner = commandRunner,
    private readonly workspace = "default",
    private readonly repo = repoDir,
    private readonly ledger: OperationLedger = new MemoryOperationLedger(),
    private readonly lockDirectory?: string,
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
      " for line in sys.stdin:",
      "  old,new,ref=line.split()",
      '  principal=os.getenv("EPHYRA_PRINCIPAL") or os.getenv("GL_USER") or os.getenv("USER") or "unknown"',
      "  item=dict(old=old,new=new,ref=ref,principal=principal,time=datetime.datetime.now(datetime.timezone.utc).isoformat())",
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
    for (const line of data.subarray(0, offset).toString().split("\n")) {
      if (!line) continue;
      const item = JSON.parse(line);
      seen.add(`${item.ref}\0${item.new}`);
    }
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
  /** Where a trail branch forked from the repository's default branch (trail_ref landings have no oldOid). */
  private async mergeBase(oid: string): Promise<string> {
    for (const ref of ["refs/heads/main", "refs/heads/master", "HEAD"]) {
      const r = await this.run(["git", "merge-base", oid, ref], this.repoDir);
      if (!r.code && r.stdout.trim()) return r.stdout.trim();
    }
    throw new Error("cannot find what to restore for this landing");
  }
  private async serial<T>(target: string, f: () => Promise<T>): Promise<T> {
    const lockKey = `${this.repoDir}\0${target}`;
    const prev = this.locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(lockKey, next);
    await prev;
    let lockPath: string | undefined;
    let lockOwned = false;
    try {
      if (this.lockDirectory) {
        await mkdir(this.lockDirectory, { recursive: true });
        lockPath = join(this.lockDirectory, digest(lockKey).slice(7) + ".lock");
        for (;;) {
          try {
            const handle = await open(lockPath, "wx");
            lockOwned = true;
            await handle.close();
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
      }
      return await f();
    } finally {
      try {
        if (lockPath && lockOwned) await unlink(lockPath);
      } finally {
        release();
        if (this.locks.get(lockKey) === next) this.locks.delete(lockKey);
      }
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
    receipt: LandingReceipt,
    idempotencyKey: string,
  ): Promise<LandingReceipt> {
    if (!idempotencyKey) throw new Error("idempotency key required");
    return this.serial(receipt.target, async () => {
      const operation = await this.ledger.begin(
        idempotencyKey,
        digest(JSON.stringify(["revert", receipt])),
      );
      if (!operation.fresh) {
        if (operation.record.status === "done")
          return operation.record.result as LandingReceipt;
        throw new ReconciliationRequired(
          idempotencyKey,
          "revert requires reconciliation",
        );
      }
      // Restore the pre-landing tree in one commit on top of the landed head. This undoes every commit
      // the landing brought in (including same-tree trailer commits) and needs no working tree.
      if (!receipt.oldOid && receipt.mode !== "trail_ref") throw new Error("receipt has no prior state to restore");
      // trail_ref landings create a new branch, so the prior state is where it forked from the default branch.
      const restoreFrom = receipt.oldOid ?? (await this.mergeBase(receipt.newOid));
      if (restoreFrom === receipt.newOid) throw new Error("landing introduced nothing to revert");
      const tree = (await this.git("rev-parse", `${restoreFrom}^{tree}`)).trim();
      const message = `Revert landing ${receipt.newOid.slice(0, 12)}\n\nRestores ${restoreFrom}.\nEphyra-Revert-Of: ${receipt.newOid}\n`;
      const made = await this.run(
        ["git", "-c", "user.name=ephyra", "-c", "user.email=ephyra@localhost",
          "commit-tree", tree, "-p", receipt.newOid, "-m", message],
        this.repoDir,
      );
      if (made.code) throw new Error(`revert commit failed: ${made.stderr.trim().slice(0, 300)}`);
      const oid = made.stdout.trim();
      let update;
      try {
        update = await this.run(
          ["git", "update-ref", receipt.target, oid, receipt.newOid],
          this.repoDir,
        );
      } catch {
        await this.ledger.markAmbiguous(idempotencyKey, "revert update outcome unknown");
        throw new ReconciliationRequired(idempotencyKey, "revert update outcome unknown");
      }
      if (update.code) throw new BaseMoved(receipt.target);
      const reverted: LandingReceipt = {
        ...receipt,
        oldOid: receipt.newOid,
        newOid: oid,
        at: new Date().toISOString(),
      };
      await this.ledger.complete(idempotencyKey, reverted);
      return reverted;
    });
  }
}
