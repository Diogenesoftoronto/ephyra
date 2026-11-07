// Real HTTP authorization, state machine, engine and git journal; policy effects are recorded fakes.
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { Trail, TrailEvent, type Effect, type TransitionContext } from '@ephyra/core';
import { GitJournal } from '@ephyra/journal';
import { MemorySignalStore } from '@ephyra/ingest';
import { AUTONOMY_TEMPLATE, THRESHOLDS_TEMPLATE, parseAutonomy, parseThresholds } from '@ephyra/policy';
import { MemoryAudit } from '../audit.ts';
import { createApp, InvalidTransition } from '../http/app.ts';
import type { EffectHandlers } from '../orchestrator.ts';
import { MemoryOperationLedger } from '../orchestrator/effects.ts';
import { collaborationEventId, httpPort } from './human.ts';
import { Engine } from './runtime.ts';
import { MemoryStore } from './store.ts';
import { FakeContext, type ServerContext } from './context.ts';

const id = '00000000-0000-4000-8000-000000000001';
const now = '2026-11-07T00:00:00.000Z';
const sha = 'a'.repeat(40);
const context: TransitionContext = { now, blocking: { A: true, B: true, C: true }, landingModes: ['trail_ref'] };
const fixtureTrail = () => Trail.parse({
  schema: 1, id, short: 'T-000001', repo: 'test', title: 'Review fixture', rev: 1, state: 'hypothesised',
  signals: [id], area: 'checkout', risk: 'medium', route: 'auto_fix', severity: 1,
  base: { ref: 'main', sha }, head: sha, checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
  budget: { tokensUsed: 0, tokensMax: 1, wallclockMaxS: 1, spendMicrousdUsed: 0, spendMicrousdMax: 0 },
  mirrors: {}, createdAt: now, updatedAt: now,
});
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ephyra-collaboration-')); dirs.push(dir);
  const init = Bun.spawn(['git', 'init', '--bare', '-q', dir], { stdout: 'ignore', stderr: 'pipe' });
  if (await init.exited) throw new Error(await new Response(init.stderr).text());
  const journal = new GitJournal({ gitDir: dir, clock: { now: () => new Date(now) } });
  const store = new MemoryStore();
  const ledger = new MemoryOperationLedger();
  const effects: Effect[] = [];
  const makeEngine = () => {
    const engine = new Engine(store, journal, ledger, async () => context, { uuidv7: () => crypto.randomUUID() }, () => {});
    engine.setHandlers(new Proxy({}, { get: () => async (effect: Effect) => { effects.push(effect); } }) as EffectHandlers);
    return engine;
  };
  let engine = makeEngine();
  const trail = fixtureTrail();
  const initial = TrailEvent.parse({ schema: 1, id: crypto.randomUUID(), trail: id, rev: 1, at: now,
    actor: { kind: 'system', id: 'fixture' }, type: 'trail_created',
    data: { signalId: id, title: trail.title, baseRef: 'main', baseSha: sha } });
  await engine.start(trail, initial);
  await store.inboxPut({ id: `${id}:A`, trailId: id, short: trail.short, title: trail.title, area: trail.area,
    risk: trail.risk, severity: 1, state: trail.state, bound: { rev: 1, head: sha }, kind: 'checkpoint',
    checkpoint: 'A', blocking: true, artefact: { path: 'hypothesis.md', summary: 'Review' }, createdAt: now });
  const ctx: ServerContext = new FakeContext(
    { id: 'test', url: dir, mirrorDir: dir, baseRef: 'main', forge: 'plain', remote: 'origin' },
    { autonomy: parseAutonomy(AUTONOMY_TEMPLATE), thresholds: parseThresholds(THRESHOLDS_TEMPLATE) },
    journal, new MemorySignalStore(),
  );
  ctx.emit = async (input) => { await engine.emit(input); };
  ctx.trails = { get: (key) => store.getTrail(key), list: () => store.listTrails(), events: (key) => store.events(key) };
  ctx.inbox = { get: (key) => store.inboxGet(key), list: () => store.inboxList(), put: (item) => store.inboxPut(item),
    remove: (key) => store.inboxRemove(key) };
  const audit = new MemoryAudit();
  let auditGate: (() => Promise<void>) | null = null;
  const port = httpPort(ctx, { append: async (input) => { await auditGate?.(); return audit.append(input); } });
  const app = createApp('service-token', port, new Hono(), async (token) =>
    ['alice', 'bob', 'reader'].includes(token) ? { did: `did:example:${token}` } : null,
    { requireSignIn: true, approvers: new Set(['did:example:alice', 'did:example:bob']) });
  const headers = (who: string, key?: string) => ({ Authorization: `Bearer ${who}`, 'Content-Type': 'application/json',
    'X-Ephyra-Principal': 'did:example:spoofed', ...(key ? { 'Idempotency-Key': key } : {}) });
  const action = (who: string, action: string, input = {}, key?: string) =>
    app.request(`/v1/trails/${id}/${action}`, { method: 'POST', headers: headers(who, key), body: JSON.stringify(input) });
  const status = (who: string, action: string, key: string) =>
    app.request(`/v1/trails/${id}/operations/${action}?key=${encodeURIComponent(key)}`, { headers: headers(who) });
  return { app, ctx, store, journal, effects, audit, action, status, headers, engine: () => engine,
    restart: () => { engine = makeEngine(); }, setAuditGate: (gate: (() => Promise<void>) | null) => { auditGate = gate; } };
}

test('two approvers race for one review, author identity is server-derived, and only the owner can release', async () => {
  const f = await fixture();
  const responses = await Promise.all([f.action('alice', 'claim', {}, 'alice-claim'), f.action('bob', 'claim', {}, 'bob-claim')]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const current = (await f.journal.read(id))!;
  const owner = current.trail.owner!.id.split(':').at(-1)!;
  const other = owner === 'alice' ? 'bob' : 'alice';
  expect(current.trail.owner!.id).not.toContain('spoofed');
  expect(f.effects).toEqual([]);
  expect((await f.action(other, 'comment', { text: 'Keep the receipt rounding.' }, 'note')).status).toBe(200);
  expect((await f.action(other, 'release', {}, 'wrong-release')).status).toBe(409);
  for (const action of ['park', 'kill', 'resume', 'land']) expect((await f.action(owner, action)).status).toBe(409);
  expect((await f.action(owner, 'release', {}, 'release')).status).toBe(200);
  const released = (await f.journal.read(id))!.trail;
  expect(released).toMatchObject({ state: 'hypothesised', rev: 1, head: sha });
  expect(released.owner).toBeUndefined();
});

test('comment receipts survive engine recreation, reject changed intent, and are private to the action and principal', async () => {
  const f = await fixture();
  const input = { text: 'A durable comment' };
  expect((await f.action('alice', 'comment', input, 'stable')).status).toBe(200);
  f.restart();
  expect((await f.action('alice', 'comment', input, 'stable')).status).toBe(200);
  expect((await f.action('alice', 'comment', { text: 'Changed content' }, 'stable')).status).toBe(409);
  const comments = (await f.journal.read(id))!.events.filter((e) => e.type === 'human_comment');
  expect(comments).toHaveLength(1);
  expect(comments[0]!.actor).toEqual({ kind: 'human', id: 'did:example:alice' });
  expect(await (await f.status('alice', 'comment', 'stable')).json()).toEqual({ status: 'recorded' });
  expect(await (await f.status('bob', 'comment', 'stable')).json()).toEqual({ status: 'not_found' });
  expect(await (await f.status('alice', 'claim', 'stable')).json()).toEqual({ status: 'not_found' });
  expect(JSON.stringify(f.audit.events)).not.toContain(input.text);
  expect(f.audit.events.every((event) => event.action.endsWith('.requested'))).toBe(true);
});

test('a successful journal append remains readable and an explicit same-key retry repairs a failed projection', async () => {
  const f = await fixture();
  const put = f.store.putTrail.bind(f.store);
  let fail = true;
  f.store.putTrail = async (trail) => { if (fail) { fail = false; throw new Error('projection unavailable'); } await put(trail); };
  const intent = { trail: id, actor: { kind: 'human' as const, id: 'did:example:alice' },
    type: 'claimed_by_human' as const, data: {}, eventId: collaborationEventId(id, 'did:example:alice', 'claim', 'repair') };
  await expect(f.engine().emit(intent)).rejects.toThrow('projection unavailable');
  expect((await f.store.getTrail(id))!.state).toBe('hypothesised');
  expect(await (await f.status('alice', 'claim', 'repair')).json()).toEqual({ status: 'recorded' });
  const read = await (await f.app.request(`/v1/trails/${id}`, { headers: f.headers('bob') })).json();
  expect(read.trail.owner.id).toBe('did:example:alice');
  f.restart();
  await f.engine().emit(intent);
  expect((await f.store.getTrail(id))!.state).toBe('handed_off');
  expect((await f.store.events(id)).filter((e) => e.type === 'claimed_by_human')).toHaveLength(1);
  // A late retry after release repairs the latest projection, never resurrecting the older claim.
  expect((await f.action('alice', 'release', {}, 'release')).status).toBe(200);
  await f.engine().emit(intent);
  expect((await f.store.getTrail(id))!.owner).toBeUndefined();
});

test('invalid notes, keys, machine writes and read-only writers are refused before any journal mutation', async () => {
  const f = await fixture();
  for (const text of ['', '  \n', 'x'.repeat(4001)]) expect((await f.action('alice', 'comment', { text }, 'bad')).status).toBe(400);
  expect((await f.action('alice', 'comment', { text: 'hi' }, 'bad key')).status).toBe(400);
  expect((await f.action('alice', 'claim', { owner: 'bob' })).status).toBe(400);
  expect((await f.action('reader', 'comment', { text: 'no' })).status).toBe(403);
  expect((await f.action('service-token', 'claim')).status).toBe(403);
  expect((await f.action('missing', 'claim')).status).toBe(401);
  expect((await f.status('alice', 'kill', 'key')).status).toBe(400);
  expect((await f.journal.read(id))!.events).toHaveLength(1);
});

test('a claim racing a decision is rejected atomically as HTTP 409, without losing the checkpoint', async () => {
  const f = await fixture();
  let ready!: () => void, resume!: () => void;
  const entered = new Promise<void>((r) => { ready = r; });
  const blocked = new Promise<void>((r) => { resume = r; });
  f.setAuditGate(async () => { f.setAuditGate(null); ready(); await blocked; });
  const decision = f.action('alice', 'decide', { checkpoint: 'A', verdict: 'approve', bound: { rev: 1, head: sha } });
  await entered;
  expect((await f.action('bob', 'claim', {}, 'claim')).status).toBe(200);
  resume();
  expect((await decision).status).toBe(409);
  expect(await f.store.inboxGet(`${id}:A`)).not.toBeNull();
  expect((await f.journal.read(id))!.events.some((e) => e.type === 'checkpoint_decided')).toBe(false);
});

test('expected review binding is checked inside the engine, and active/terminal trails cannot be claimed', async () => {
  const f = await fixture();
  await expect(f.engine().emit({ trail: id, actor: { kind: 'human', id: 'alice' }, expectedBound: { rev: 2, head: sha },
    type: 'checkpoint_decided', data: { checkpoint: 'A', decision: { by: 'human', who: 'alice', at: now, verdict: 'approve' } },
  })).rejects.toThrow('reviewed revision changed');
  await f.engine().emit({ trail: id, actor: { kind: 'human', id: 'alice' },
    type: 'checkpoint_decided', data: { checkpoint: 'A', decision: { by: 'human', who: 'alice', at: now, verdict: 'approve' } },
  });
  expect((await f.action('alice', 'claim', {}, 'active')).status).toBe(409);
  await f.engine().emit({ trail: id, actor: { kind: 'human', id: 'alice' }, type: 'killed', data: { reason: 'test end' } });
  expect((await f.action('alice', 'claim', {}, 'closed')).status).toBe(409);
  await expect(f.engine().emit({ trail: id, actor: { kind: 'system', id: 'machine' },
    type: 'claimed_by_human', data: {}, eventId: crypto.randomUUID() })).rejects.toBeInstanceOf(InvalidTransition);
});
