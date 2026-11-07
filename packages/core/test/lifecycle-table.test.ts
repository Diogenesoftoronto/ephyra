import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { createTrail, fold, shortId, Trail, TrailEvent, transition } from '../src/index.ts';
import type { TransitionContext } from '../src/index.ts';

const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const now = '2026-11-07T00:00:00Z';
const sha = 'a'.repeat(40);
const ctx: TransitionContext = { now, blocking: { A: true, B: true, C: true }, landingModes: ['trail_ref'] };
const original = Trail.parse({
  schema: 1, id, short: shortId(id), repo: 'repo', title: 'test', rev: 1, state: 'researching',
  signals: [id], area: 'a', risk: 'low', route: 'auto_fix', severity: 1, base: { ref: 'main', sha },
  checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
  budget: { tokensUsed: 0, tokensMax: 1, wallclockMaxS: 1, spendMicrousdUsed: 0, spendMicrousdMax: 0 },
  mirrors: {}, createdAt: now, updatedAt: now,
});
const event = (type: string, data: unknown, eventId = other) => TrailEvent.parse({
  schema: 1, id: eventId, trail: id, rev: 1, at: now, actor: { kind: 'system', id: 'test' }, type, data,
});
const decision = (verdict: 'approve' | 'revise' | 'reject', shadow = false) => ({
  by: 'human', at: now, verdict, shadow,
});
const bundle = (passed: boolean) => ({
  schema: 1, trail: id, rev: 1, risk: 'low', base: sha, head: sha, items: [], passed,
  missing: passed ? [] : ['tests'], env: { runner: 'test' }, computedAt: now,
});
const receipt = { mode: 'trail_ref', target: 'main', oldOid: null, newOid: sha, at: now };
const watch = {
  windowS: 1, fingerprints: [], touchedFiles: [], routes: [], areaProbes: [], baseline: { errorRate: 0 }, startedAt: now,
};
const triage = {
  route: 'auto_fix', risk: 'low', area: 'a', severity: 1, actionable: 1,
  confidence: { route: 1, duplicateOf: 1 }, backends: { decide: 'test/model' }, reasons: [], notifyHuman: false,
};
type Case = {
  name: string; state: Trail['state']; type: string; data: unknown; next: Trail['state'];
  effects?: import('../src/index.ts').Effect['type'][]; patch?: Partial<Trail>;
};
const cases: Case[] = [
  { name: 'start triage', state: 'sensed', type: 'trail_created', data: { signalId: id, title: 'x', baseRef: 'main', baseSha: sha }, next: 'sensed', effects: ['run_triage'] },
  { name: 'triage auto', state: 'sensed', type: 'triage_completed', data: { result: triage }, next: 'researching', effects: ['start_agent'] },
  { name: 'triage human', state: 'triaged', type: 'triage_completed', data: { result: { ...triage, route: 'human' } }, next: 'parked', effects: ['notify_inbox'] },
  { name: 'triage duplicate', state: 'triaged', type: 'triage_completed', data: { result: { ...triage, duplicateOf: other } }, next: 'abandoned', effects: ['merge_signal'] },
  { name: 'triage ignore', state: 'sensed', type: 'triage_completed', data: { result: { ...triage, route: 'ignore' } }, next: 'abandoned' },
  { name: 'triage conflict', state: 'sensed', type: 'triage_completed', data: { result: { ...triage, conflictsWith: other } }, next: 'parked' },
  { name: 'research A', state: 'researching', type: 'research_completed', data: { hypothesis: 'h' }, next: 'hypothesised', effects: ['request_checkpoint'] },
  { name: 'approve A', state: 'hypothesised', type: 'checkpoint_decided', data: { checkpoint: 'A', decision: decision('approve') }, next: 'reproducing', effects: ['start_agent'] },
  { name: 'revise A', state: 'hypothesised', type: 'checkpoint_decided', data: { checkpoint: 'A', decision: decision('revise') }, next: 'researching', effects: ['start_agent'] },
  { name: 'reject A', state: 'hypothesised', type: 'checkpoint_decided', data: { checkpoint: 'A', decision: decision('reject') }, next: 'abandoned' },
  { name: 'research only', state: 'hypothesised', patch: { route: 'research_only' }, type: 'checkpoint_decided', data: { checkpoint: 'A', decision: decision('approve') }, next: 'parked', effects: ['notify_inbox'] },
  { name: 'repro success', state: 'reproducing', type: 'repro_completed', data: { ok: true }, next: 'reproducing', effects: ['start_agent'] },
  { name: 'cannot repro', state: 'reproducing', type: 'repro_completed', data: { ok: false }, next: 'parked', effects: ['notify_inbox'] },
  { name: 'plan B', state: 'reproducing', type: 'plan_completed', data: { plan: 'p' }, next: 'planned', effects: ['request_checkpoint'] },
  { name: 'approve B', state: 'planned', type: 'checkpoint_decided', data: { checkpoint: 'B', decision: decision('approve') }, next: 'patching', effects: ['start_agent'] },
  { name: 'revise B', state: 'planned', type: 'checkpoint_decided', data: { checkpoint: 'B', decision: decision('revise') }, next: 'reproducing', effects: ['start_agent'] },
  { name: 'patch proof', state: 'patching', type: 'patch_completed', data: { head: sha, revision: 1 }, next: 'proving', effects: ['run_proof'] },
  { name: 'proof passes C', state: 'proving', type: 'proof_completed', data: { bundle: bundle(true), digest: 'x' }, next: 'ready', effects: ['request_checkpoint'] },
  { name: 'proof fails', state: 'proving', type: 'proof_completed', data: { bundle: bundle(false), digest: 'x' }, next: 'patching', effects: ['start_agent'] },
  { name: 'proof max', state: 'proving', patch: { attempts: { proof: 2, maxProof: 3 } }, type: 'proof_completed', data: { bundle: bundle(false), digest: 'x' }, next: 'parked', effects: ['notify_inbox'] },
  { name: 'approve C', state: 'ready', type: 'checkpoint_decided', data: { checkpoint: 'C', decision: decision('approve') }, next: 'landing', effects: ['land'] },
  { name: 'revise C', state: 'ready', type: 'checkpoint_decided', data: { checkpoint: 'C', decision: decision('revise') }, next: 'patching', effects: ['start_agent'] },
  { name: 'land request', state: 'ready', patch: { checkpoints: { C: decision('approve') as Trail['checkpoints']['C'], spend: [] } }, type: 'land_requested', data: {}, next: 'landing', effects: ['land'] },
  { name: 'landing complete', state: 'landing', type: 'landing_completed', data: { receipt }, next: 'watching', effects: ['start_watch'] },
  { name: 'base moved', state: 'landing', type: 'base_moved', data: { newSha: sha, overlapsTouchedFiles: true }, next: 'patching', effects: ['rebase'] },
  { name: 'landing failed', state: 'landing', type: 'landing_failed', data: { reason: 'failed', baseMoved: false }, next: 'parked', effects: ['notify_inbox'] },
  { name: 'landing race', state: 'landing', type: 'landing_failed', data: { reason: 'race', baseMoved: true }, next: 'patching', effects: ['rebase'] },
  { name: 'watch started', state: 'watching', type: 'watch_started', data: { config: watch }, next: 'watching' },
  { name: 'watch clean', state: 'watching', type: 'watch_completed', data: { outcome: 'clean' }, next: 'closed', effects: ['register_regression_probe', 'resume_dependents'] },
  { name: 'watch regression', state: 'watching', type: 'probe_regressed_after_landing', data: { criterion: 'c', evidence: 'e' }, next: 'rolled_back', effects: ['rollback'] },
  { name: 'rollback complete', state: 'rolled_back', patch: { watchEvidence: 'e' }, type: 'rollback_completed', data: { receipt }, next: 'researching', effects: ['start_agent'] },
  { name: 'pause', state: 'patching', type: 'parked', data: { reason: 'pause' }, next: 'parked', effects: ['notify_inbox'] },
  { name: 'resume', state: 'parked', patch: { resumeTo: 'patching' }, type: 'resumed', data: {}, next: 'patching' },
  { name: 'claim', state: 'patching', type: 'claimed_by_human', data: {}, next: 'handed_off', effects: ['stop_agent'] },
  { name: 'revision', state: 'patching', type: 'human_revision', data: { head: sha }, next: 'handed_off', effects: ['stop_agent', 'run_proof'] },
  { name: 'release', state: 'handed_off', patch: { resumeTo: 'proving' }, type: 'released_by_human', data: {}, next: 'proving' },
  { name: 'kill', state: 'patching', type: 'killed', data: { reason: 'stop' }, next: 'abandoned', effects: ['stop_agent'] },
  { name: 'signal proving', state: 'proving', type: 'new_signal', data: { signalId: other, severity: 3 }, next: 'proving', effects: ['run_proof'] },
  { name: 'signal ready', state: 'ready', type: 'new_signal', data: { signalId: other, severity: 3 }, next: 'proving', effects: ['run_proof'] },
  { name: 'comment', state: 'researching', type: 'human_comment', data: { text: 'hello', isRequest: false }, next: 'researching', effects: ['reply_comment'] },
  { name: 'request at B', state: 'planned', type: 'human_comment', data: { text: 'change', isRequest: true }, next: 'reproducing', effects: ['start_agent'] },
  { name: 'request elsewhere', state: 'researching', type: 'human_comment', data: { text: 'change', isRequest: true }, next: 'researching', effects: ['reply_comment'] },
  { name: 'spend request', state: 'proving', type: 'spend_requested', data: { purpose: 'study', microusd: 10 }, next: 'proving', effects: ['request_spend'] },
  { name: 'spend approve', state: 'proving', patch: { pendingSpend: { purpose: 'study', microusd: 10 } }, type: 'spend_decided', data: { decision: decision('approve') }, next: 'proving', effects: ['start_respondent_run'] },
  { name: 'spend reject', state: 'proving', patch: { pendingSpend: { purpose: 'study', microusd: 10 } }, type: 'spend_decided', data: { decision: decision('reject') }, next: 'proving' },
  { name: 'child', state: 'researching', type: 'child_trail_finished', data: { child: other, proofDigest: 'digest' }, next: 'researching', effects: ['deliver_child_evidence'] },
  { name: 'parent', state: 'parked', patch: { parent: other, waitingForParent: true, resumeTo: 'researching' }, type: 'parent_trail_landed', data: { parent: other }, next: 'researching', effects: ['start_agent'] },
  { name: 'intent', state: 'researching', type: 'intent_updated', data: { intent: 'checkout' }, next: 'researching', effects: ['run_probes'] },
  { name: 'budget', state: 'patching', type: 'budget_exceeded', data: { summary: 'spent' }, next: 'parked', effects: ['notify_inbox'] },
  { name: 'agent retry', state: 'patching', type: 'agent_failed', data: { step: 'patch', reason: 'error', retryable: true }, next: 'patching', effects: ['start_agent'] },
  { name: 'agent failure', state: 'patching', type: 'agent_failed', data: { step: 'patch', reason: 'error', retryable: false }, next: 'parked', effects: ['notify_inbox'] },
];

for (const entry of cases) {
  test(entry.name, () => {
    const trail = Trail.parse({ ...original, state: entry.state, ...entry.patch });
    const e = event(entry.type, entry.data);
    const result = fold(trail, [e], ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trail.state).toBe(entry.next);
    expect(result.effects.map(effect => effect.type)).toEqual(entry.effects ?? []);
    expect(Trail.safeParse(result.trail).success).toBe(true);
    expect(transition(trail, e, ctx)).toEqual(result);
  });
}

const signal = {
  schema: 1 as const, id, kind: 'error' as const, repo: 'repo', environment: 'production',
  fingerprint: 'fingerprint', title: 'test', message: 'error', frames: [], firstSeen: now, lastSeen: now,
  count: 1, attributes: {}, source: 'test',
};
const createInput = {
  id, signal, title: 'test', repo: 'repo', base: original.base,
  triage: triage as import('../src/index.ts').TriageResult, now, budget: original.budget,
};

test('creation triage outcomes and regression preserve identity and severity', () => {
  const auto = createTrail(createInput);
  expect(auto.trail?.short).toBe(shortId(id));
  expect(auto.effects[0]?.type).toBe('start_agent');
  const duplicate = createTrail({ ...createInput, triage: { ...createInput.triage, duplicateOf: other } });
  expect(duplicate.trail).toBeNull();
  expect(duplicate.effects[0]?.type).toBe('merge_signal');
  const human = createTrail({ ...createInput, triage: { ...createInput.triage, route: 'human' } });
  expect(human.trail?.state).toBe('parked');
  expect(human.effects[0]?.type).toBe('notify_inbox');
  const ignore = createTrail({ ...createInput, triage: { ...createInput.triage, route: 'ignore' } });
  expect(ignore.trail?.state).toBe('abandoned');
  expect(ignore.effects[0]).toMatchObject({ type: 'mute_fingerprint', forS: 86400 });
  const conflict = createTrail({ ...createInput, triage: { ...createInput.triage, conflictsWith: other } });
  expect(conflict.trail).toMatchObject({ parent: other, state: 'parked', waitingForParent: true });
  expect(conflict.effects).toEqual([]);
  const old = { ...original, id: other, short: shortId(other), state: 'closed' as const, severity: 4, rev: 3 };
  const reopened = createTrail({ ...createInput, triage: { ...createInput.triage, regressionOf: other }, regressionTrail: old });
  expect(reopened.trail).toMatchObject({ id: other, rev: 4, severity: 4, state: 'researching' });
  expect(() => createTrail({ ...createInput, triage: { ...createInput.triage, regressionOf: other } })).toThrow();
});

for (const cp of ['A', 'B', 'C'] as const) {
  const states = { A: 'hypothesised', B: 'planned', C: 'ready' } as const;
  test(`shadow ${cp} records without advancement`, () => {
    const trail = { ...original, state: states[cp] };
    const result = transition(trail, event('checkpoint_decided', { checkpoint: cp, decision: decision('approve', true) }), ctx);
    expect(result.ok && result.trail.state).toBe(states[cp]);
    expect(result.ok && result.trail.checkpoints[cp]?.shadow).toBe(true);
  });
}

test('advisory checkpoint decisions advance and blocking decisions wait', () => {
  const approve = decision('approve') as import('../src/index.ts').Decision;
  const advisory: TransitionContext = { ...ctx, blocking: { A: false, B: false, C: false }, autoDecision: { A: approve, B: approve, C: approve } };
  const a = transition(original, event('research_completed', { hypothesis: 'h' }), advisory);
  expect(a.ok && a.trail.state).toBe('reproducing');
  const b = transition({ ...original, state: 'reproducing' }, event('plan_completed', { plan: 'p' }), advisory);
  expect(b.ok && b.trail.state).toBe('patching');
  const c = transition({ ...original, state: 'proving' }, event('proof_completed', { bundle: bundle(true), digest: 'x' }), { ...advisory, autoDecision: undefined, autoDecisionC: approve });
  expect(c.ok && c.trail.state).toBe('landing');
  const blocked = transition(original, event('research_completed', { hypothesis: 'h' }), { ...advisory, blocking: ctx.blocking });
  expect(blocked.ok && blocked.trail.state).toBe('hypothesised');
});

test('watch evidence and human revision bind later proof to the new revision', () => {
  const regression = event('probe_regressed_after_landing', { criterion: 'c', evidence: 'watch/log' });
  const rollback = event('rollback_completed', { receipt }, '00000000-0000-4000-8000-000000000003');
  const result = fold({ ...original, state: 'watching' }, [regression, rollback], ctx);
  expect(result.ok && result.trail.rev).toBe(2);
  expect(result.ok && result.effects[1]).toMatchObject({ type: 'start_agent', note: 'watch/log' });
  const revised = transition(original, event('human_revision', { head: sha }), ctx);
  expect(revised.ok && revised.trail.rev).toBe(2);
  if (!revised.ok) return;
  const proof = { ...bundle(true), rev: 2 };
  const proved = transition(revised.trail, event('proof_completed', { bundle: proof, digest: 'x' }), ctx);
  expect(proved.ok && proved.trail).toMatchObject({ state: 'handed_off', resumeTo: 'ready' });
});

test('random event sequences preserve schema, revision and replay invariants', () => {
  const events = cases.map(c => event(c.type, c.data));
  fc.assert(fc.property(fc.array(fc.constantFrom(...events), { maxLength: 100 }), (sequence) => {
    let trail = original;
    for (const [index, template] of sequence.entries()) {
      const e = { ...template, id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}` };
      const result = transition(trail, e, ctx);
      expect(transition(trail, e, ctx)).toEqual(result);
      if (!result.ok) continue;
      expect(Trail.safeParse(result.trail).success).toBe(true);
      expect(result.trail.rev).toBeGreaterThanOrEqual(trail.rev);
      expect(new Set(result.effects.map(effect => effect.key)).size).toBe(result.effects.length);
      trail = result.trail;
    }
  }));
});

test('terminal states absorb every event', () => {
  for (const state of ['closed', 'abandoned'] as const) {
    for (const c of cases) expect(transition({ ...original, state }, event(c.type, c.data), ctx).ok).toBe(false);
  }
});
