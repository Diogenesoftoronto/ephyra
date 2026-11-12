import { AUTONOMY_LEVELS, type AreaSketch, type AutonomyLevel, type Decision, type Trail } from "@ephyra/core";
import type { Ask } from "./team-space.ts";

/**
 * Why an ask needs a person, why Ephyra did not settle it alone, and what would let it settle the next one.
 * Every sentence is built from recorded facts: the area's autonomy level, the checkpoint's blocking mode, budgets,
 * proof attempts, and the people's own past decisions. Nothing here is a model's guess, and no suggestion claims an
 * outcome it cannot see.
 */
export type GuidanceTrail = Pick<Trail, "id" | "area" | "risk" | "route" | "state" | "checkpoints" | "budget" | "attempts"> &
  Partial<Pick<Trail, "pendingSpend" | "resumeTo">>;

export interface Step {
  id: string;
  title: string;
  detail: string;
  href?: string;
  /** The recorded facts the step rests on, shown beside it. */
  evidence?: string;
}
export interface Guidance { why: string[]; notAlone: string; steps: Step[] }

/** Clean human approvals at one checkpoint in one area before Ephyra suggests raising that area's autonomy. */
export const RAISE_AFTER = 5;
const STEP_NAME = { A: "hypothesis", B: "plan", C: "landing" } as const;
const WORKSPACE = "#/workspace";

export function nextLevel(level: AutonomyLevel): AutonomyLevel | null {
  const i = AUTONOMY_LEVELS.findIndex((l) => l.id === level);
  return AUTONOMY_LEVELS[i + 1]?.id ?? null;
}
const levelOf = (id: AutonomyLevel) => AUTONOMY_LEVELS.find((l) => l.id === id)!;

/** People's verdicts at one checkpoint across an area's quests. Policy and shadow decisions are not a person's. */
export function record(trails: readonly GuidanceTrail[], area: string, checkpoint: "A" | "B" | "C" | "spend") {
  const decisions: Decision[] = [];
  for (const t of trails) {
    if (t.area !== area) continue;
    if (checkpoint === "spend") decisions.push(...t.checkpoints.spend);
    else if (t.checkpoints[checkpoint]) decisions.push(t.checkpoints[checkpoint]!);
  }
  const human = decisions.filter((d) => d.by === "human" && !d.shadow);
  return {
    approved: human.filter((d) => d.verdict === "approve" && !d.note?.trim()).length,
    changed: human.filter((d) => d.verdict !== "approve" || Boolean(d.note?.trim())).length,
    notes: human.filter((d) => d.verdict !== "approve" && d.note?.trim()).map((d) => d.note!.trim()).slice(0, 3),
  };
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
const intentStep = (area: string, what: string): Step => ({
  id: "intent", title: `Write it down in the ${area} intent`,
  detail: `${what} Every future quest in ${area} reads this file, so the same gap stops coming back.`, href: WORKSPACE,
});

export function guidance(ask: Ask, input: {
  trail?: GuidanceTrail;
  trails: readonly GuidanceTrail[];
  /** `undefined` when the autonomy document could not be read. */
  sketches?: readonly AreaSketch[];
  bridge?: "connected" | "incomplete" | "off" | "unknown";
  recipientHasAccount?: boolean;
  shadowVerdict?: "approve" | "revise" | "reject";
}): Guidance {
  const t = input.trail;
  const area = t?.area ?? "this area";
  const sketch = t ? input.sketches?.find((s) => s.name === t.area) : undefined;
  const policy = !t ? null
    : input.sketches === undefined ? "The autonomy policy could not be read, so the level for this area is unknown."
    : sketch ? `${area} runs at ${levelOf(sketch.level).label}: ${levelOf(sketch.level).means}`
    : `No area in the autonomy policy covers ${area}, so the default checkpoints apply.`;

  if (ask.kind === "question") {
    const steps: Step[] = [intentStep(area, "Record the answer as a rule, with the case that raised it.")];
    if (ask.waitingOn.kind === "contact" || input.recipientHasAccount === false)
      steps.push({ id: "invite", title: "Invite the person who knows", href: "#/team/access",
        detail: "With an account they answer inside Ephyra, and the answer is checked against the same revision." });
    if (ask.delivery === "unconfirmed" || ask.delivery === "not_sent" || (ask.waitingOn.kind === "contact" && input.bridge !== "connected"))
      steps.push({ id: "bridge", title: "Connect the delivery bridge", href: "#/settings",
        detail: "Questions for people outside the inbox go through your relay to Slack or wherever your team talks." });
    steps.push({ id: "knowledge", title: "Connect the source that holds the answer", href: "#/settings",
      detail: "A shared knowledge source lets Ephyra look this up before it asks anyone." });
    return {
      why: [ask.detail || "The investigation needs one fact it could not find."],
      notAlone: "The answer is a product decision, not something the code shows. "
        + "Ephyra does not guess product rules. It asks one checked question and waits.",
      steps,
    };
  }

  if (ask.kind === "checkpoint" && ask.checkpoint) {
    const cp = ask.checkpoint;
    const name = STEP_NAME[cp];
    const mode = ask.blocking ? "blocking here, so the quest waits for a person" : "advisory here, so the quest keeps going while it waits";
    const why = [policy, `Checkpoint ${cp} (${name}) is ${mode}.`]
      .filter((x): x is string => Boolean(x));
    if (t && (t.risk === "high" || t.risk === "critical")) why.push(`The quest is ${t.risk} risk.`);
    if (t?.route === "human") why.push("Triage sent this quest to a person.");
    const r = t ? record(input.trails, t.area, cp) : { approved: 0, changed: 0, notes: [] };
    const steps: Step[] = [];
    const up = sketch ? nextLevel(sketch.level) : null;
    const evidence = `${r.approved} approved unchanged, ${r.changed} changed or refused at ${name} in ${area}`;
    if (sketch && up && r.changed === 0 && r.approved >= RAISE_AFTER)
      steps.push({ id: "raise", title: `Raise ${area} to ${levelOf(up).label}`, href: WORKSPACE, evidence,
        detail: `You have approved every ${name} here without changes. ${levelOf(up).means}` });
    else if (r.changed > 0)
      steps.push({ ...intentStep(area, `Say what you changed in past ${name} reviews${r.notes.length ? ` ("${r.notes[0]}")` : ""} as a rule.`),
        evidence });
    else if (sketch && up)
      steps.push({ id: "track", title: `${RAISE_AFTER - r.approved} more clean approvals before raising ${area}`, evidence,
        detail: `After ${RAISE_AFTER} unchanged approvals in a row, Ephyra suggests ${levelOf(up).label} for this area.` });
    if (cp === "C")
      steps.push({ id: "proof", title: "Turn your landing check into proof", href: WORKSPACE,
        detail: "Write down what you look at before you approve a landing as acceptance in the intent doc. "
          + "Ephyra adds it to the proof, so the check no longer depends on a person." });
    return {
      why,
      notAlone: input.shadowVerdict
        ? `The shadow reviewer would ${input.shadowVerdict}. Shadow verdicts are recorded but never act until policy allows it.`
        : `Policy does not let Ephyra approve its own ${name} in ${area}.`,
      steps,
    };
  }

  if (ask.kind === "spend") {
    const p = t?.pendingSpend;
    const b = t?.budget;
    const r = t ? record(input.trails, t.area, "spend") : { approved: 0, changed: 0, notes: [] };
    const steps: Step[] = [];
    if (r.approved >= 3 && r.changed === 0)
      steps.push({ id: "budget", title: `Raise the per-quest budget for ${area}`, href: WORKSPACE,
        evidence: `${r.approved} of ${r.approved} spend requests approved in ${area}`,
        detail: "Requests you always approve can sit inside the budget, so they no longer stop the quest." });
    steps.push({ id: "cheaper", title: "Check whether a cheaper model would do", href: "#/settings",
      detail: "Model access is set per role. A smaller model for this step may fit the current budget." });
    return {
      why: [
        p ? `It needs ${usd(p.microusd)} for ${p.purpose}.` : "It needs to spend past its budget.",
        ...(b ? [`The quest has used ${usd(b.spendMicrousdUsed)} of ${usd(b.spendMicrousdMax)}.`] : []),
      ],
      notAlone: "Spending past a cap always needs a person. A question or a context reset cannot get around it.",
      steps,
    };
  }

  // Parked.
  const proofSpent = t ? t.attempts.proof >= t.attempts.maxProof : false;
  const budgetSpent = t ? t.budget.spendMicrousdUsed >= t.budget.spendMicrousdMax : false;
  return {
    why: [
      proofSpent ? `It used all ${t!.attempts.maxProof} proof attempts.`
        : budgetSpent ? "It reached its spending cap." : "It stopped and needs a person to say whether to go on.",
      ...(t?.resumeTo ? [`Resuming picks up at ${t.resumeTo.replace(/_/g, " ")}.`] : []),
    ],
    notAlone: "Ephyra parks rather than retrying blindly. Another attempt with the same evidence would likely fail the same way.",
    steps: [
      proofSpent
        ? { id: "repro", title: "Make the failure reproducible in the sandbox", href: "#/settings",
          detail: "A seed, fixture, or service the runner can reach lets Ephyra prove the fix itself instead of running out of attempts." }
        : { id: "budget", title: `Review the budget for ${area}`, href: WORKSPACE,
          detail: "If quests here often run out, the cap may be too low for the work." },
      intentStep(area, "Note what you decide when you resume, so the next quest can decide the same way."),
    ],
  };
}

/** Where people step in most, and the change that would remove the most of those stops. */
export function patterns(asks: readonly Ask[], byId: ReadonlyMap<string, GuidanceTrail>, trails: readonly GuidanceTrail[],
  sketches: readonly AreaSketch[] | undefined, now: number, days = 30) {
  const since = now - days * 86_400_000;
  const stops = new Map<string, { open: number; decided: number }>();
  const bump = (area: string, key: "open" | "decided") => {
    const s = stops.get(area) ?? { open: 0, decided: 0 };
    s[key] += 1;
    stops.set(area, s);
  };
  for (const a of asks) { const t = byId.get(a.trailId); if (t) bump(t.area, "open"); }
  for (const t of trails) {
    for (const d of [t.checkpoints.A, t.checkpoints.B, t.checkpoints.C, ...t.checkpoints.spend]) {
      if (d && d.by === "human" && !d.shadow && Date.parse(d.at) >= since) bump(t.area, "decided");
    }
  }
  return [...stops.entries()].map(([area, s]) => {
    const sketch = sketches?.find((x) => x.name === area);
    const cps = (["A", "B", "C"] as const).map((cp) => ({ cp, ...record(trails, area, cp) }));
    const changed = cps.reduce((n, c) => n + c.changed, 0);
    const approved = cps.reduce((n, c) => n + c.approved, 0);
    const up = sketch ? nextLevel(sketch.level) : null;
    const move = !sketch ? `Add ${area} to the autonomy policy`
      : !up ? "Already at the highest level; the stops come from questions and spend"
      : changed === 0 && approved >= RAISE_AFTER ? `Ready to try ${levelOf(up).label}`
      : changed > 0 ? `Write your ${changed === 1 ? "change" : "changes"} into the ${area} intent first`
      : `${Math.max(0, RAISE_AFTER - approved)} more clean approvals before ${levelOf(up).label}`;
    return { area, level: sketch?.level ?? null, open: s.open, decided: s.decided, approved, changed, move };
  }).sort((a, b) => b.open + b.decided - (a.open + a.decided) || a.area.localeCompare(b.area));
}
