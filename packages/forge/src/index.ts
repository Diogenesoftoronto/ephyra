import { Unverified, ReconciliationRequired, type ForgeAdapter, type ForgeCapabilities, type ForgeEvent, type LandingPlan, type LandingReceipt, type LandingMode, type Trail } from '@ephyra/core';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type CommandRunner = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>;
export const commandRunner: CommandRunner = async (args, cwd) => {
  const p = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
};
export class BaseMoved extends Error { constructor(public readonly target: string) { super(`base moved: ${target}`); this.name = 'BaseMoved'; } }
const digest = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const caps = (adapter: string, modes: LandingMode[], verified: boolean): ForgeCapabilities => ({ adapter, events: verified, conditionalWrites: verified, proposals: false, ci: false, signing: false, landingModes: modes, customRefs: verified ? 'supported' : 'unknown', verified });

export class PlainGitAdapter implements ForgeAdapter {
  readonly name = 'plain-git';
  private readonly completed = new Map<string, { plan: string; receipt: LandingReceipt }>();
  private readonly locks = new Map<string, Promise<void>>();
  constructor(public readonly repoDir: string, private readonly run: CommandRunner = commandRunner, private readonly workspace = 'default', private readonly repo = repoDir) {}
  async capabilities(): Promise<ForgeCapabilities> { return caps(this.name, ['trail_ref', 'auto_land'], true); }
  private async git(...args: string[]) { const r = await this.run(['git', ...args], this.repoDir); if (r.code) throw new Error(r.stderr || `git exited ${r.code}`); return r.stdout.trim(); }
  async installHook(repoDir = this.repoDir) {
    const result = await this.run(['git', 'rev-parse', '--absolute-git-dir'], repoDir);
    if (result.code) throw new Error(result.stderr);
    const dir = result.stdout.trim();
    // Python performs JSON escaping; append mode keeps each received update on one line.
    const hook = `#!/bin/sh\nexec python3 -c 'import sys,os,json\np=os.path.join(${JSON.stringify(dir)}, "ephyra-spool.jsonl")\nwith open(p,"a") as f:\n for line in sys.stdin:\n  old,new,ref=line.split()\n  f.write(json.dumps(dict(old=old,new=new,ref=ref,principal=os.getenv("GL_USER") or os.getenv("EPHYRA_PRINCIPAL") or os.getenv("USER") or "unknown"))+"\\n")'\n`;
    await writeFile(join(dir, 'hooks', 'post-receive'), hook, { flag: 'wx' }); await chmod(join(dir, 'hooks', 'post-receive'), 0o755);
  }
  async *events(cursor: string | null): AsyncIterable<ForgeEvent> {
    const dir = await this.git('rev-parse', '--absolute-git-dir');
    let data: Buffer; try { data = await readFile(join(dir, 'ephyra-spool.jsonl')); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
    const offset = cursor === null ? 0 : Number(cursor); if (!Number.isSafeInteger(offset) || offset < 0 || offset > data.length) throw new Error('invalid spool cursor');
    let pos = offset; const seen = new Set<string>();
    for (;;) { const end = data.indexOf(10, pos); if (end < 0) break; const line = data.subarray(pos, end).toString(); pos = end + 1; const item = JSON.parse(line); const key = `${item.ref}\0${item.new}`; if (seen.has(key)) continue; seen.add(key);
      yield { workspace: this.workspace, repo: this.repo, adapter: this.name, sourceId: key, cursor: String(pos), occurredAt: new Date().toISOString(), kind: 'push', commit: item.new, ref: item.ref, actor: item.principal, payloadDigest: digest(line) };
    }
  }
  async prepareLanding(_trail: Trail, _mode: LandingMode, _expectedBase: string): Promise<LandingPlan> { throw new Unverified('landing plan requires proof digest supplied by caller'); }
  private async serial<T>(target: string, f: () => Promise<T>): Promise<T> { const prev = this.locks.get(target) ?? Promise.resolve(); let release!: () => void; const next = new Promise<void>(r => { release = r; }); this.locks.set(target, next); await prev; try { return await f(); } finally { release(); if (this.locks.get(target) === next) this.locks.delete(target); } }
  async land(plan: LandingPlan, authorizationId: string, idempotencyKey: string): Promise<LandingReceipt> {
    if (!idempotencyKey || !authorizationId) throw new Error('authorization and idempotency key required');
    if (plan.mode !== 'trail_ref' && plan.mode !== 'auto_land') throw new Unverified(plan.mode);
    const target = plan.mode === 'trail_ref' ? `refs/heads/ephyra/${plan.trailId}` : plan.target;
    return this.serial(target, async () => {
      const signature = JSON.stringify([plan, authorizationId]); const prior = this.completed.get(idempotencyKey); if (prior) { if (prior.plan !== signature) throw new Error('idempotency key reused'); return prior.receipt; }
      if (plan.mode === 'auto_land' && plan.commitMessage !== undefined) { const message = await this.git('show', '-s', '--format=%B', plan.head); if (message !== plan.commitMessage.trim()) throw new Error('approved commit message does not match head'); }
      const old = plan.mode === 'trail_ref' ? '0'.repeat(plan.head.length) : plan.expectedBase;
      let result; try { result = await this.run(['git', 'update-ref', target, plan.head, old], this.repoDir); } catch { throw new ReconciliationRequired(idempotencyKey, 'update-ref outcome unknown'); }
      if (result.code) { const current = await this.run(['git', 'rev-parse', '--verify', target], this.repoDir); if (current.stdout.trim() !== old) throw new BaseMoved(target); throw new Error(result.stderr); }
      const receipt: LandingReceipt = { mode: plan.mode, target, oldOid: plan.mode === 'trail_ref' ? null : old, newOid: plan.head, authorizationId, proofDigest: plan.proofDigest, at: new Date().toISOString() }; this.completed.set(idempotencyKey, { plan: signature, receipt }); return receipt;
    });
  }
  async revert(_receipt: LandingReceipt, _idempotencyKey: string): Promise<LandingReceipt> { throw new Unverified('git revert commit and durable idempotency'); }
}

export class TangledAdapter implements ForgeAdapter {
  readonly name = 'tangled';
  async capabilities(): Promise<ForgeCapabilities> { return caps(this.name, ['trail_ref', 'tangled_pull'], false); }
  async *events(_cursor: string | null): AsyncIterable<ForgeEvent> { throw new Unverified('Tangled org.tangled schemas: design/02-platform.md §1'); }
  async prepareLanding(_trail: Trail, _mode: LandingMode, _base: string): Promise<LandingPlan> { throw new Unverified('Tangled landing preparation'); }
  async land(_plan: LandingPlan, _auth: string, _key: string): Promise<LandingReceipt> { throw new Unverified('Tangled writes: design/02-platform.md §1'); }
  async revert(_receipt: LandingReceipt, _key: string): Promise<LandingReceipt> { throw new Unverified('Tangled revert'); }
}
export class RadicleAdapter implements ForgeAdapter {
  readonly name = 'radicle';
  async capabilities(): Promise<ForgeCapabilities> { return { ...caps(this.name, ['radicle_patch'], false), proposals: true }; }
  async *events(_cursor: string | null): AsyncIterable<ForgeEvent> { throw new Unverified('Radicle event ingestion'); }
  async prepareLanding(_trail: Trail, _mode: LandingMode, _base: string): Promise<LandingPlan> { throw new Unverified('Radicle landing preparation'); }
  // Patch push and CI event reference: https://radicle-ci-broker.liw.fi/userguide.html
  async land(_plan: LandingPlan, _auth: string, _key: string): Promise<LandingReceipt> { throw new Unverified('Radicle patch push and receipt'); }
  async revert(_receipt: LandingReceipt, _key: string): Promise<LandingReceipt> { throw new Unverified('Radicle revert'); }
}
export function landingFor(modes: LandingMode[], adapters: ForgeAdapter[]): Map<LandingMode, ForgeAdapter> {
  const result = new Map<LandingMode, ForgeAdapter>();
  for (const mode of modes) { if (mode === 'devenv_live') throw new Error('devenv_live is handled by the runner'); const name = mode === 'radicle_patch' ? 'radicle' : mode === 'tangled_pull' ? 'tangled' : 'plain-git'; const adapter = adapters.find(a => a.name === name); if (!adapter) throw new Error(`no adapter for ${mode}`); result.set(mode, adapter); } return result;
}
