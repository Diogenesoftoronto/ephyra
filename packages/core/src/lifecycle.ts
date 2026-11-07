import type { Trail, Signal, TriageResult, Budget, TrailState, Decision } from './schemas.ts';
import { shortId } from './ids.ts';
import { z } from 'zod';
import type { TrailEvent, Effect, TransitionContext, TransitionResult } from './events.ts';

type Command = Effect extends infer E ? E extends Effect ? Omit<E, 'key'> : never : never;
type Checkpoint = 'A' | 'B' | 'C';
type EventOf<T extends TrailEvent['type']> = Extract<TrailEvent, { type: T }>;
type Step = 'research' | 'repro' | 'plan' | 'patch' | 'review';

export type CreateTrailInput = {
  id: string;
  signal: Signal;
  title: string;
  repo: string;
  base: Trail['base'];
  triage: TriageResult;
  now: string;
  budget: Budget;
  /** Required to reopen a regression, preserving the original trail and severity. */
  regressionTrail?: Trail;
};
export type CreateTrailResult = { trail: Trail | null; effects: Effect[] };

function keyed(id: string, rev: number, eventId: string, commands: Command[]): Effect[] {
  const counts = new Map<string, number>();
  return commands.map((command) => {
    const identity = command.type;
    const count = counts.get(identity) ?? 0;
    counts.set(identity, count + 1);
    return { ...command, key: `${id}:${rev}:${command.type}:${eventId}:${count}` } as Effect;
  });
}

export function createTrail(input: CreateTrailInput): CreateTrailResult {
  const { triage, signal } = input;
  for (const target of [triage.duplicateOf, triage.regressionOf, triage.conflictsWith]) {
    if (target && !z.uuid().safeParse(target).success) throw new Error('Invalid triage target');
  }
  if (triage.duplicateOf) {
    return { trail: null, effects: keyed(input.id, 1, signal.id, [
      { type: 'merge_signal', signalId: signal.id, into: triage.duplicateOf },
    ]) };
  }
  if (triage.regressionOf) {
    const original = input.regressionTrail;
    if (!original || original.id !== triage.regressionOf || original.state !== 'closed') {
      throw new Error('A matching closed regression trail is required');
    }
    const trail: Trail = {
      ...structuredClone(original), rev: original.rev + 1, state: 'researching',
      signals: [...new Set([...original.signals, signal.id])],
      severity: Math.max(original.severity, triage.severity), updatedAt: input.now,
      attempts: { ...original.attempts, proof: 0 },
    };
    delete trail.resumeTo;
    return { trail, effects: keyed(trail.id, trail.rev, signal.id, [{ type: 'start_agent', step: 'research' }]) };
  }
  const state = triage.route === 'ignore' ? 'abandoned'
    : triage.route === 'human' || triage.conflictsWith ? 'parked' : 'researching';
  const trail: Trail = {
    schema: 1, id: input.id, short: shortId(input.id), repo: input.repo, title: input.title,
    rev: 1, state, ...(state === 'parked' ? { resumeTo: 'researching' as const } : {}),
    signals: [signal.id], signalFingerprint: signal.fingerprint, area: triage.area, risk: triage.risk,
    route: triage.route === 'ignore' ? 'human' : triage.route, severity: triage.severity,
    base: input.base, checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
    budget: input.budget, mirrors: {}, ...(triage.conflictsWith ? { parent: triage.conflictsWith, waitingForParent: true } : {}),
    createdAt: input.now, updatedAt: input.now,
  };
  const commands: Command[] = state === 'abandoned'
    ? [{ type: 'mute_fingerprint', fingerprint: signal.fingerprint, forS: 86400 }]
    : state === 'parked'
      ? triage.conflictsWith ? [] : [{ type: 'notify_inbox', reason: 'Needs a human' }]
      : [{ type: 'start_agent', step: 'research' }];
  if (triage.notifyHuman && state === 'researching') {
    commands.push({ type: 'notify_inbox', reason: 'Triage notification' });
  }
  return { trail, effects: keyed(trail.id, trail.rev, signal.id, commands) };
}

class Machine {
  readonly trail: Trail;
  readonly commands: Command[] = [];
  constructor(trail: Trail, readonly ctx: TransitionContext) { this.trail = structuredClone(trail); }
  agent(step: Step, note?: string) {
    this.commands.push({ type: 'start_agent', step, ...(note === undefined ? {} : { note }) });
  }
  park(reason: string) {
    if (this.trail.state !== 'parked') this.trail.resumeTo = this.trail.state;
    this.trail.state = 'parked';
    this.commands.push({ type: 'notify_inbox', reason });
  }
  checkpoint(cp: Checkpoint) {
    this.commands.push({ type: 'request_checkpoint', checkpoint: cp, blocking: this.ctx.blocking[cp] });
    const decision = this.ctx.autoDecision?.[cp] ?? (cp === 'C' ? this.ctx.autoDecisionC : undefined);
    if (!this.ctx.blocking[cp] && decision) this.decide(cp, decision);
  }
  decide(cp: Checkpoint, decision: Decision): boolean {
    const state = { A: 'hypothesised', B: 'planned', C: 'ready' } as const;
    if (this.trail.state !== state[cp]) return false;
    this.trail.checkpoints[cp] = decision;
    if (decision.shadow) return true;
    if (decision.verdict === 'reject') {
      this.trail.state = 'abandoned';
    } else if (decision.verdict === 'revise') {
      const states = { A: 'researching', B: 'reproducing', C: 'patching' } as const;
      const steps = { A: 'research', B: 'plan', C: 'patch' } as const;
      this.trail.state = states[cp];
      this.agent(steps[cp], decision.note);
    } else if (cp === 'A' && this.trail.route === 'research_only') {
      this.park('Research complete');
    } else if (cp === 'A') {
      this.trail.state = 'reproducing';
      this.agent('repro');
    } else if (cp === 'B') {
      this.trail.state = 'patching';
      this.agent('patch');
    } else {
      this.trail.state = 'landing';
      this.commands.push({ type: 'land', modes: this.ctx.landingModes });
    }
    return true;
  }
  new_signal(e: EventOf<'new_signal'>) {
    if (!this.trail.signals.includes(e.data.signalId)) this.trail.signals.push(e.data.signalId);
    this.trail.severity = Math.max(this.trail.severity, e.data.severity ?? 0);
    if (this.trail.state === 'proving' || this.trail.state === 'ready') {
      this.trail.state = 'proving';
      delete this.trail.checkpoints.C;
      this.commands.push({ type: 'run_proof' });
    }
    return true;
  }
  research_completed(_e: EventOf<'research_completed'>) {
    if (this.trail.state !== 'researching') return false;
    this.trail.state = 'hypothesised';
    this.checkpoint('A');
    return true;
  }
  checkpoint_decided(e: EventOf<'checkpoint_decided'>) { return this.decide(e.data.checkpoint, e.data.decision); }
  repro_completed(e: EventOf<'repro_completed'>) {
    if (this.trail.state !== 'reproducing') return false;
    if (e.data.ok) this.agent('plan');
    else this.park(e.data.reason ?? 'Cannot reproduce');
    return true;
  }
  plan_completed(_e: EventOf<'plan_completed'>) {
    if (this.trail.state !== 'reproducing') return false;
    this.trail.state = 'planned';
    this.checkpoint('B');
    return true;
  }
  patch_completed(e: EventOf<'patch_completed'>) {
    if (this.trail.state !== 'patching' || e.data.revision < this.trail.rev) return false;
    delete this.trail.checkpoints.C;
    this.trail.rev = e.data.revision;
    this.trail.head = e.data.head;
    this.trail.state = 'proving';
    this.commands.push({ type: 'run_proof' });
    return true;
  }
  proof_completed(e: EventOf<'proof_completed'>) {
    const bundle = e.data.bundle;
    if (this.trail.state !== 'proving' || bundle.trail !== this.trail.id || bundle.rev !== this.trail.rev) return false;
    if (bundle.passed && this.ctx.proofSufficient !== false) {
      this.trail.state = 'ready';
      this.checkpoint('C');
    } else {
      this.trail.attempts.proof++;
      if (this.trail.attempts.proof >= this.trail.attempts.maxProof) this.park('Proof attempts exhausted');
      else {
        this.trail.state = 'patching';
        this.agent('patch', `Missing: ${bundle.missing.join(', ')}`);
      }
    }
    return true;
  }
  land_requested(e: EventOf<'land_requested'>) {
    if (this.trail.state !== 'ready' || this.trail.checkpoints.C?.verdict !== 'approve'
      || this.trail.checkpoints.C.shadow) return false;
    this.trail.state = 'landing';
    this.commands.push({ type: 'land', modes: e.data.modes ?? this.ctx.landingModes });
    return true;
  }
  landing_completed(e: EventOf<'landing_completed'>) {
    if (this.trail.state !== 'landing') return false;
    this.trail.landing?.receipts.push(e.data.receipt);
    this.trail.state = 'watching';
    this.commands.push({ type: 'start_watch' });
    return true;
  }
  landing_failed(e: EventOf<'landing_failed'>) {
    if (this.trail.state !== 'landing') return false;
    if (e.data.baseMoved) {
      this.trail.state = 'patching';
      this.commands.push({ type: 'rebase', onto: this.trail.base.sha });
    } else this.park(e.data.reason);
    return true;
  }
  base_moved(e: EventOf<'base_moved'>) {
    if (!['proving', 'ready', 'landing'].includes(this.trail.state)) return false;
    delete this.trail.checkpoints.C;
    this.trail.base.sha = e.data.newSha;
    this.trail.state = 'patching';
    this.commands.push({ type: 'rebase', onto: e.data.newSha });
    return true;
  }
  watch_started(_e: EventOf<'watch_started'>) { return this.trail.state === 'watching'; }
  watch_completed(_e: EventOf<'watch_completed'>) {
    if (this.trail.state !== 'watching') return false;
    this.trail.state = 'closed';
    this.commands.push({ type: 'register_regression_probe' }, { type: 'resume_dependents' });
    return true;
  }
  probe_regressed_after_landing(e: EventOf<'probe_regressed_after_landing'>) {
    if (this.trail.state !== 'watching') return false;
    this.trail.watchEvidence = e.data.evidence;
    this.trail.state = 'rolled_back';
    this.commands.push({ type: 'rollback', criterion: e.data.criterion });
    return true;
  }
  rollback_completed(e: EventOf<'rollback_completed'>) {
    if (this.trail.state !== 'rolled_back') return false;
    this.trail.landing?.receipts.push(e.data.receipt);
    this.trail.rev++;
    this.trail.state = 'researching';
    this.trail.attempts.proof = 0;
    this.agent('research', this.trail.watchEvidence);
    return true;
  }
  human_comment(e: EventOf<'human_comment'>) {
    const cp = ({ hypothesised: 'A', planned: 'B', ready: 'C' } as Partial<Record<TrailState, Checkpoint>>)[this.trail.state];
    if (e.data.isRequest && cp) {
      this.decide(cp, { by: 'human', at: this.ctx.now, verdict: 'revise', note: e.data.text });
    } else this.commands.push({ type: 'reply_comment', text: e.data.text });
    return true;
  }
  claimed_by_human(_e: EventOf<'claimed_by_human'>) {
    if (this.trail.state === 'handed_off') return false;
    this.trail.resumeTo = this.trail.state;
    this.trail.state = 'handed_off';
    this.commands.push({ type: 'stop_agent', releaseLease: true });
    return true;
  }
  human_revision(e: EventOf<'human_revision'>) {
    if (this.trail.state !== 'handed_off') this.claimed_by_human({} as EventOf<'claimed_by_human'>);
    delete this.trail.checkpoints.C;
    if (this.trail.head !== e.data.head) this.trail.rev++;
    this.trail.head = e.data.head;
    this.trail.resumeTo = 'proving';
    this.commands.push({ type: 'run_proof' });
    return true;
  }
  released_by_human(_e: EventOf<'released_by_human'>) {
    if (this.trail.state !== 'handed_off' || !this.trail.resumeTo) return false;
    this.trail.state = this.trail.resumeTo;
    delete this.trail.resumeTo;
    return true;
  }
  parked(e: EventOf<'parked'>) {
    if (this.trail.state === 'parked') return false;
    this.park(e.data.reason);
    return true;
  }
  resumed(_e: EventOf<'resumed'>) {
    if (this.trail.state !== 'parked' || !this.trail.resumeTo || this.trail.waitingForParent) return false;
    this.trail.state = this.trail.resumeTo;
    delete this.trail.resumeTo;
    return true;
  }
  killed(_e: EventOf<'killed'>) {
    this.trail.state = 'abandoned';
    this.commands.push({ type: 'stop_agent', releaseLease: true });
    return true;
  }
  budget_exceeded(e: EventOf<'budget_exceeded'>) { this.park(e.data.summary); return true; }
  spend_requested(e: EventOf<'spend_requested'>) {
    if (this.trail.pendingSpend) return false;
    this.trail.pendingSpend = e.data;
    this.commands.push({ type: 'request_spend', ...e.data });
    return true;
  }
  spend_decided(e: EventOf<'spend_decided'>) {
    if (!this.trail.pendingSpend) return false;
    this.trail.checkpoints.spend.push(e.data.decision);
    if (!e.data.decision.shadow) {
      if (e.data.decision.verdict === 'approve') {
        this.commands.push({ type: 'start_respondent_run', ...this.trail.pendingSpend });
      }
      delete this.trail.pendingSpend;
    }
    return true;
  }
  child_trail_finished(e: EventOf<'child_trail_finished'>) {
    this.commands.push({ type: 'deliver_child_evidence', ...e.data });
    return true;
  }
  parent_trail_landed(e: EventOf<'parent_trail_landed'>) {
    if (this.trail.state !== 'parked' || this.trail.parent !== e.data.parent) return false;
    if (!this.trail.waitingForParent) return false;
    delete this.trail.waitingForParent;
    delete this.trail.resumeTo;
    this.trail.state = 'researching';
    this.agent('research');
    return true;
  }
  intent_updated(e: EventOf<'intent_updated'>) {
    this.commands.push({ type: 'run_probes', probes: [e.data.intent], reason: 'Intent updated' });
    return true;
  }
  agent_failed(e: EventOf<'agent_failed'>) {
    const steps: Step[] = ['research', 'repro', 'plan', 'patch', 'review'];
    if (e.data.retryable && steps.includes(e.data.step as Step)) this.agent(e.data.step as Step, e.data.reason);
    else this.park(e.data.reason);
    return true;
  }
  trail_created(e: EventOf<'trail_created'>) {
    if (this.trail.state !== 'sensed') return false;
    if (e.data.fingerprint) this.trail.signalFingerprint = e.data.fingerprint;
    this.commands.push({ type: 'run_triage', signalId: e.data.signalId });
    return true;
  }
  triage_completed(e: EventOf<'triage_completed'>) {
    if (this.trail.state !== 'sensed' && this.trail.state !== 'triaged') return false;
    const result = e.data.result;
    for (const target of [result.duplicateOf, result.regressionOf, result.conflictsWith]) {
      if (target && !z.uuid().safeParse(target).success) return false;
    }
    this.trail.area = result.area;
    this.trail.risk = result.risk;
    this.trail.severity = Math.max(this.trail.severity, result.severity);
    this.trail.route = result.route === 'ignore' ? 'human' : result.route;
    if (result.duplicateOf) {
      this.trail.state = 'abandoned';
      for (const signalId of this.trail.signals) {
        this.commands.push({ type: 'merge_signal', signalId, into: result.duplicateOf });
      }
    } else if (result.regressionOf) {
      // Reopening requires the closed trail; use createTrail with regressionTrail instead.
      return false;
    } else if (result.route === 'ignore') {
      if (!this.trail.signalFingerprint) return false;
      this.trail.state = 'abandoned';
      this.commands.push({ type: 'mute_fingerprint', fingerprint: this.trail.signalFingerprint, forS: 86400 });
    } else if (result.conflictsWith) {
      this.trail.parent = result.conflictsWith;
      this.trail.waitingForParent = true;
      this.trail.resumeTo = 'researching';
      this.trail.state = 'parked';
    } else if (result.route === 'human') {
      this.trail.state = 'triaged';
      this.park('Needs a human');
    } else {
      this.trail.state = 'researching';
      this.agent('research');
    }
    return true;
  }
}

export function transition(trail: Trail, event: TrailEvent, ctx: TransitionContext): TransitionResult {
  if (event.trail !== trail.id) return { ok: false, error: 'Event belongs to another trail' };
  if (trail.state === 'closed' || trail.state === 'abandoned') return { ok: false, error: 'Terminal trail' };
  const humanProof = trail.state === 'handed_off' && trail.resumeTo === 'proving'
    && event.type === 'proof_completed';
  const startingTrail = humanProof ? { ...trail, state: 'proving' as const } : trail;
  const effectiveContext = humanProof ? { ...ctx, blocking: { ...ctx.blocking, C: true } } : ctx;
  const machine = new Machine(startingTrail, effectiveContext);
  // Every event handler has the matching discriminated event type; the lookup retains that pairing.
  const handler = machine[event.type] as (event: TrailEvent) => boolean;
  if (typeof handler !== 'function' || !handler.call(machine, event)) return { ok: false, error: `Invalid ${event.type} in ${trail.state}` };
  if (humanProof && machine.trail.state !== 'abandoned') {
    machine.trail.resumeTo = machine.trail.state;
    machine.trail.state = 'handed_off';
  }
  machine.trail.updatedAt = ctx.now;
  return { ok: true, trail: machine.trail, effects: keyed(trail.id, machine.trail.rev, event.id, machine.commands) };
}

export function fold(initial: Trail, events: TrailEvent[], ctx: TransitionContext): TransitionResult {
  let trail = initial;
  const effects: Effect[] = [];
  for (const event of events) {
    const result = transition(trail, event, ctx);
    if (!result.ok) return result;
    trail = result.trail;
    effects.push(...result.effects);
  }
  return { ok: true, trail, effects };
}
