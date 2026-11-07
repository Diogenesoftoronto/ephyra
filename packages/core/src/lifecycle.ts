import type { Trail, Signal, TriageResult, Budget, TrailState } from './schemas.ts';
import { shortId } from './ids.ts';
import type { TrailEvent, Effect, TransitionContext, TransitionResult } from './events.ts';

type Command = Effect extends infer E ? E extends Effect ? Omit<E, 'key'> : never : never;
export type CreateTrailInput = { id: string; signal: Signal; title: string; repo: string; base: Trail['base']; triage: TriageResult; now: string; budget: Budget };
export type CreateTrailResult = { trail: Trail | null; effects: Effect[] };
const keys = (id: string, rev: number, discriminator: string, commands: Command[]): Effect[] => commands.map((c, i) => ({ ...c, key: `${id}:${rev}:${c.type}:${discriminator}:${JSON.stringify(c)}:${i}` }) as Effect);
export function createTrail(x: CreateTrailInput): CreateTrailResult {
  const t = x.triage;
  if (t.duplicateOf) return { trail: null, effects: keys(x.id, 1, 'create', [{ type: 'merge_signal', signalId: x.signal.id, into: t.duplicateOf }]) };
  const state = t.route === 'ignore' ? 'abandoned' : t.route === 'human' || t.conflictsWith ? 'parked' : 'researching';
  const trail: Trail = { schema: 1, id: x.id, short: shortId(x.id), repo: x.repo, title: x.title, rev: 1, state, ...(state === 'parked' ? { resumeTo: 'researching' as const } : {}), signals: [x.signal.id], area: t.area, risk: t.risk, route: t.route === 'ignore' ? 'human' : t.route, severity: t.severity, base: x.base, checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 }, budget: x.budget, mirrors: {}, ...(t.conflictsWith ? { parent: t.conflictsWith } : {}), createdAt: x.now, updatedAt: x.now };
  const commands: Command[] = state === 'abandoned' ? [{ type: 'mute_fingerprint', fingerprint: x.signal.fingerprint, forS: 86400 }] : state === 'parked' ? [{ type: 'notify_inbox', reason: 'Needs a human' }] : [{ type: 'start_agent', step: 'research' }];
  if (t.notifyHuman && state === 'researching') commands.push({ type: 'notify_inbox', reason: 'Triage notification' });
  return { trail, effects: keys(x.id, 1, 'create', commands) };
}
export function transition(trail: Trail, event: TrailEvent, ctx: TransitionContext): TransitionResult {
  if (event.trail !== trail.id) return { ok: false, error: 'Event belongs to another trail' };
  if (trail.state === 'closed' || trail.state === 'abandoned') return { ok: false, error: 'Terminal trail' };
  const t: Trail = structuredClone(trail); const c: Command[] = [];
  const agent = (step: 'research'|'repro'|'plan'|'patch', note?: string) => c.push({ type: 'start_agent', step, ...(note !== undefined ? { note } : {}) });
  const park = (reason: string) => { if (t.state !== 'parked') t.resumeTo = t.state; t.state = 'parked'; c.push({ type: 'notify_inbox', reason }); };
  const checkpoint = (cp: 'A'|'B'|'C') => {
    c.push({ type: 'request_checkpoint', checkpoint: cp, blocking: ctx.blocking[cp] });
    const decision = ctx.autoDecision?.[cp] ?? (cp === 'C' ? ctx.autoDecisionC : undefined);
    if (!ctx.blocking[cp] && decision) decide(cp, decision);
  };
  const decide = (cp: 'A'|'B'|'C', d: Trail['checkpoints']['A']) => {
    if (!d || t.state !== ({ A: 'hypothesised', B: 'planned', C: 'ready' } as const)[cp]) return false;
    t.checkpoints[cp] = d; if (d.shadow) return true;
    if (d.verdict === 'reject') { t.state = 'abandoned'; return true; }
    if (d.verdict === 'revise') { const states = { A: 'researching', B: 'reproducing', C: 'patching' } as const; const steps = { A: 'research', B: 'plan', C: 'patch' } as const; t.state = states[cp]; agent(steps[cp], d.note); return true; }
    if (cp === 'A' && t.route === 'research_only') { park('Research complete'); return true; }
    if (cp === 'A') { t.state = 'reproducing'; agent('repro'); }
    if (cp === 'B') { t.state = 'patching'; agent('patch'); }
    if (cp === 'C') { t.state = 'landing'; c.push({ type: 'land', modes: ctx.landingModes }); }
    return true;
  };
  let valid = true;
  switch (event.type) {
    case 'new_signal': if (!t.signals.includes(event.data.signalId)) t.signals.push(event.data.signalId); t.severity = Math.max(t.severity, event.data.severity ?? 0); if (t.state === 'proving' || t.state === 'ready') { t.state = 'proving'; c.push({ type: 'run_proof' }); } break;
    case 'research_completed': if (t.state !== 'researching') { valid = false; break; } t.state = 'hypothesised'; checkpoint('A'); break;
    case 'checkpoint_decided': valid = decide(event.data.checkpoint, event.data.decision); break;
    case 'repro_completed': if (t.state !== 'reproducing') { valid = false; break; } if (!event.data.ok) park(event.data.reason ?? 'Cannot reproduce'); else agent('plan'); break;
    case 'plan_completed': if (t.state !== 'reproducing') { valid = false; break; } t.state = 'planned'; checkpoint('B'); break;
    case 'patch_completed': if (t.state !== 'patching' || event.data.revision < t.rev) { valid = false; break; } t.rev = event.data.revision; t.head = event.data.head; t.state = 'proving'; c.push({ type: 'run_proof' }); break;
    case 'proof_completed': if (t.state !== 'proving' || event.data.bundle.trail !== t.id || event.data.bundle.rev !== t.rev) { valid = false; break; } if (event.data.bundle.passed && ctx.proofSufficient !== false) { t.state = 'ready'; checkpoint('C'); } else { t.attempts.proof++; if (t.attempts.proof >= t.attempts.maxProof) park('Proof attempts exhausted'); else { t.state = 'patching'; agent('patch', `Missing: ${event.data.bundle.missing.join(', ')}`); } } break;
    case 'land_requested': if (t.state !== 'ready' || t.checkpoints.C?.verdict !== 'approve' || t.checkpoints.C.shadow) { valid = false; break; } t.state = 'landing'; c.push({ type: 'land', modes: event.data.modes ?? ctx.landingModes }); break;
    case 'landing_completed': if (t.state !== 'landing') { valid = false; break; } if (t.landing) t.landing.receipts.push(event.data.receipt); t.state = 'watching'; c.push({ type: 'start_watch' }); break;
    case 'watch_started': if (t.state !== 'watching') valid = false; break;
    case 'watch_completed': if (t.state !== 'watching') { valid = false; break; } t.state = 'closed'; c.push({ type: 'register_regression_probe' }, { type: 'resume_dependents' }); break;
    case 'probe_regressed_after_landing': if (t.state !== 'watching') { valid = false; break; } t.watchEvidence = event.data.evidence; t.state = 'rolled_back'; c.push({ type: 'rollback', criterion: event.data.criterion }); break;
    case 'rollback_completed': if (t.state !== 'rolled_back') { valid = false; break; } if (t.landing) t.landing.receipts.push(event.data.receipt); t.rev++; t.state = 'researching'; t.attempts.proof = 0; agent('research', t.watchEvidence); break;
    case 'base_moved': if (!['proving','ready','landing'].includes(t.state)) { valid = false; break; } t.base.sha = event.data.newSha; t.state = 'patching'; c.push({ type: 'rebase', onto: event.data.newSha }); break;
    case 'landing_failed': if (t.state !== 'landing') { valid = false; break; } if (event.data.baseMoved) { t.state = 'patching'; c.push({ type: 'rebase', onto: t.base.sha }); } else park(event.data.reason); break;
    case 'parked': if (t.state === 'parked') { valid = false; break; } park(event.data.reason); break;
    case 'budget_exceeded': park(event.data.summary); break;
    case 'resumed': if (t.state !== 'parked' || !t.resumeTo) { valid = false; break; } t.state = t.resumeTo; delete t.resumeTo; break;
    case 'claimed_by_human': if (t.state === 'handed_off') { valid = false; break; } t.resumeTo = t.state; t.state = 'handed_off'; c.push({ type: 'stop_agent', releaseLease: true }); break;
    case 'human_revision': if (t.state !== 'handed_off') { t.resumeTo = t.state; t.state = 'handed_off'; c.push({ type: 'stop_agent', releaseLease: true }); } t.head = event.data.head; t.resumeTo = 'proving'; c.push({ type: 'run_proof' }); break;
    case 'released_by_human': if (t.state !== 'handed_off' || !t.resumeTo) { valid = false; break; } t.state = t.resumeTo; delete t.resumeTo; break;
    case 'killed': t.state = 'abandoned'; c.push({ type: 'stop_agent', releaseLease: true }); break;
    case 'human_comment': if (event.data.isRequest) { const cp = ({ hypothesised: 'A', planned: 'B', ready: 'C' } as Partial<Record<TrailState, 'A'|'B'|'C'>>)[t.state]; if (cp) decide(cp, { by: 'human', at: ctx.now, verdict: 'revise', note: event.data.text }); else c.push({ type: 'reply_comment', text: event.data.text }); } else c.push({ type: 'reply_comment', text: event.data.text }); break;
    case 'spend_requested': t.pendingSpend = { purpose: event.data.purpose, microusd: event.data.microusd }; c.push({ type: 'request_spend', purpose: event.data.purpose, microusd: event.data.microusd }); break;
    case 'spend_decided': t.checkpoints.spend.push(event.data.decision); if (event.data.decision.verdict === 'approve' && !event.data.decision.shadow && t.pendingSpend) c.push({ type: 'start_respondent_run', ...t.pendingSpend }); if (!event.data.decision.shadow) delete t.pendingSpend; break;
    case 'parent_trail_landed': if (t.state !== 'parked') { valid = false; break; } t.state = 'researching'; delete t.resumeTo; agent('research'); break;
    case 'child_trail_finished': c.push({ type: 'deliver_child_evidence', ...event.data }); break;
    case 'intent_updated': c.push({ type: 'run_probes', probes: [event.data.intent], reason: 'Intent updated' }); break;
    case 'agent_failed': if (event.data.retryable && ['research', 'repro', 'plan', 'patch'].includes(event.data.step)) agent(event.data.step as 'research'|'repro'|'plan'|'patch', event.data.reason); else park(event.data.reason); break;
    default: valid = false;
  }
  if (!valid) return { ok: false, error: `Invalid ${event.type} in ${trail.state}` };
  t.updatedAt = ctx.now; return { ok: true, trail: t, effects: keys(t.id, t.rev, event.id, c) };
}
export function fold(initial: Trail, events: TrailEvent[], ctx: TransitionContext): TransitionResult {
  let trail = initial; const effects: Effect[] = [];
  for (const event of events) { const result = transition(trail, event, ctx); if (!result.ok) return result; trail = result.trail; effects.push(...result.effects); }
  return { ok: true, trail, effects };
}
