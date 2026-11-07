// Fictional, deterministic fixtures. Every value derives from `now`, so a story renders identically on every run.
// Nothing here is real: repositories, people, trails and engines are invented for the console catalogue.
import {
  PERSONAS,
  personaFor,
  proofDigest,
  type ProofBundle,
  type ActivityItem,
  type Draft,
  type PersonaId,
  type PolicyDoc,
  type Trail,
  type TrailEvent,
  type UsageEntry,
} from "@ephyra/core";
import type { InboxEntry } from "../api.ts";

export const STORY_NOW = Date.parse("2026-11-07T15:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

export const ME = "did:web:alex.example";
export const OTHER = "did:web:sam.example";

/** A stable 64-hex digest. Not SHA-256: the fake only needs "same text, same digest". */
export function fakeDigest(text: string): string {
  const lanes = [0xcbf29ce484222325n, 0x84222325cbf29ce4n, 0x100000001b3n, 0x9e3779b97f4a7c15n];
  for (let i = 0; i < text.length; i++) {
    lanes.forEach((h, k) => {
      lanes[k] = ((h ^ BigInt(text.charCodeAt(i) + k)) * 0x100000001b3n) & 0xffffffffffffffffn;
    });
  }
  return lanes.map((h) => h.toString(16).padStart(16, "0")).join("");
}

const sha = (n: number) => n.toString(16).padStart(8, "0").repeat(5);
const uuid = (hex6: string, n = 0) => `${hex6}aa-5b1e-4c3a-9d2f-${n.toString(16).padStart(12, "0")}`;

// ───────────────────────── Trails ─────────────────────────

type Spec = {
  hex: string;
  title: string;
  area: string;
  risk: Trail["risk"];
  state: Trail["state"];
  sev: number;
  ageH: number;
  spend: [used: number, max: number];
  tokens: [used: number, max: number];
  owner?: Trail["owner"];
  rev: number;
  pendingSpend?: Trail["pendingSpend"];
  resumeTo?: Trail["state"];
};

const SPECS: Spec[] = [
  {
    hex: "7f3a2c",
    title: "Checkout returns 500 when a coupon is applied twice",
    area: "payments",
    risk: "critical",
    state: "hypothesised",
    sev: 3.2,
    ageH: 3,
    spend: [1_240_000, 6_000_000],
    tokens: [310_000, 1_500_000],
    rev: 3,
  },
  {
    hex: "91be04",
    title: "Search results paginate past the last page",
    area: "search",
    risk: "medium",
    state: "planned",
    sev: 1.4,
    ageH: 7,
    spend: [2_810_000, 6_000_000],
    tokens: [640_000, 1_500_000],
    rev: 5,
  },
  {
    hex: "c2d018",
    title: "Session cookie is lost on the Safari redirect",
    area: "auth",
    risk: "high",
    state: "ready",
    sev: 2.8,
    ageH: 26,
    spend: [4_920_000, 6_000_000],
    tokens: [1_120_000, 1_500_000],
    rev: 9,
  },
  {
    hex: "3a77e1",
    title: "Webhook retries charge a customer twice",
    area: "payments",
    risk: "critical",
    state: "patching",
    sev: 3.6,
    ageH: 5,
    spend: [3_300_000, 5_000_000],
    tokens: [720_000, 1_500_000],
    rev: 6,
    pendingSpend: { purpose: "Run a 12-person voxq study of the new refund screen", microusd: 2_500_000 },
  },
  {
    hex: "58f0aa",
    title: "Invoice PDF renders a blank second page",
    area: "billing",
    risk: "medium",
    state: "reproducing",
    sev: 1.9,
    ageH: 1,
    spend: [410_000, 4_000_000],
    tokens: [95_000, 1_500_000],
    rev: 2,
  },
  {
    hex: "a44d52",
    title: "Currency rounding in the tax summary",
    area: "billing",
    risk: "high",
    state: "proving",
    sev: 2.2,
    ageH: 9,
    spend: [2_070_000, 4_000_000],
    tokens: [540_000, 1_500_000],
    rev: 7,
  },
  {
    hex: "0d4c19",
    title: "Rate limiter ignores X-Forwarded-For",
    area: "gateway",
    risk: "high",
    state: "watching",
    sev: 2.6,
    ageH: 40,
    spend: [3_880_000, 6_000_000],
    tokens: [900_000, 1_500_000],
    rev: 11,
  },
  {
    hex: "e19b73",
    title: "Timezone is off by one in the weekly digest email",
    area: "email",
    risk: "low",
    state: "closed",
    sev: 0.8,
    ageH: 120,
    spend: [1_530_000, 3_000_000],
    tokens: [380_000, 1_500_000],
    rev: 10,
  },
  {
    hex: "b6620f",
    title: "Flaky upload test fails on slow runners",
    area: "storage",
    risk: "low",
    state: "parked",
    sev: 0.6,
    ageH: 72,
    spend: [610_000, 3_000_000],
    tokens: [140_000, 1_500_000],
    rev: 4,
    resumeTo: "researching",
    owner: { kind: "human", id: ME },
  },
];

export function makeTrails(now: number): Trail[] {
  return SPECS.map((s, i): Trail => {
    const at = now - s.ageH * HOUR;
    const head = ["patching", "proving", "ready", "watching", "closed", "landing", "planned"].includes(
      s.state,
    )
      ? sha(0x1000 + i)
      : undefined;
    const decided = (verdict: "approve" | "revise", ago: number) => ({
      by: "human" as const,
      who: ME,
      at: iso(now - ago * HOUR),
      verdict,
      ...(verdict === "revise" ? { note: "Narrow it to the coupon path." } : {}),
    });
    const past = ["planned", "patching", "proving", "ready", "landing", "watching", "closed"].includes(
      s.state,
    );
    const pastB = ["patching", "proving", "ready", "landing", "watching", "closed"].includes(s.state);
    const pastC = ["watching", "closed"].includes(s.state);
    return {
      schema: 1,
      id: uuid(s.hex, i),
      short: `T-${s.hex}`,
      repo: "acme/storefront",
      title: s.title,
      rev: s.rev,
      state: s.state,
      ...(s.resumeTo ? { resumeTo: s.resumeTo } : {}),
      signals: [uuid(s.hex, 100 + i)],
      area: s.area,
      risk: s.risk,
      route: s.risk === "low" ? "auto_fix" : "human",
      severity: s.sev,
      base: { ref: "refs/heads/main", sha: sha(0x0b00 + i) },
      ...(head ? { head } : {}),
      ...(s.state === "watching" || s.state === "closed"
        ? { landing: { modes: ["trail_ref" as const], target: "refs/heads/main", receipts: [] } }
        : {}),
      ...(s.owner ? { owner: s.owner } : {}),
      checkpoints: {
        ...(past ? { A: decided("approve", s.ageH - 1) } : {}),
        ...(pastB
          ? {
              B: {
                ...decided("approve", s.ageH / 2),
                by: "policy" as const,
                backend: "judgement-jev/jev-1.14",
                who: undefined,
              },
            }
          : {}),
        ...(pastC ? { C: decided("approve", 2) } : {}),
        spend: [],
      },
      attempts: { proof: s.state === "proving" ? 2 : s.state === "ready" ? 1 : 0, maxProof: 3 },
      budget: {
        tokensUsed: s.tokens[0],
        tokensMax: s.tokens[1],
        wallclockMaxS: 7200,
        spendMicrousdUsed: s.spend[0],
        spendMicrousdMax: s.spend[1],
      },
      ...(s.pendingSpend ? { pendingSpend: s.pendingSpend } : {}),
      mirrors: {},
      createdAt: iso(at),
      updatedAt: iso(now - (i + 1) * 9 * MIN),
    };
  });
}

// ───────────────────────── Inbox ─────────────────────────

const ARTEFACTS: Record<string, { path: string; summary: string }> = {
  "7f3a2c": {
    path: "trails/T-7f3a2c/hypothesis.md",
    summary:
      "Coupon state is read before the lock; a second apply doubles the discount and trips a check constraint.",
  },
  "91be04": {
    path: "trails/T-91be04/plan.md",
    summary: "Clamp the page index in the cursor helper and add a boundary test. 14 lines, one file.",
  },
  c2d018: {
    path: "trails/T-c2d018/proof.json",
    summary: "Repro passes after the fix. 212 tests pass, 0 new failures, regression probes clean.",
  },
  "3a77e1": {
    path: "trails/T-3a77e1/spend.md",
    summary: "A real-respondent study of the refund screen before checkpoint C.",
  },
  b6620f: {
    path: "trails/T-b6620f/notes.md",
    summary: "Parked by Alex: waiting for the slow-runner pool to be rebuilt.",
  },
};

export function makeInbox(trails: Trail[], now: number): InboxEntry[] {
  const t = (hex: string) => trails.find((x) => x.short === `T-${hex}`)!;
  const item = (hex: string, kind: InboxEntry["kind"], extra: Partial<InboxEntry>): InboxEntry => {
    const tr = t(hex);
    return {
      trailId: tr.id,
      short: tr.short,
      title: tr.title,
      area: tr.area,
      risk: tr.risk,
      severity: tr.severity,
      state: tr.state,
      bound: { rev: tr.rev, ...(tr.head ? { head: tr.head } : {}) },
      kind,
      blocking: false,
      artefact: ARTEFACTS[hex]!,
      createdAt: iso(now - (kind === "parked" ? 70 : 2) * HOUR),
      ...extra,
    };
  };
  return [
    item("c2d018", "checkpoint", {
      checkpoint: "C",
      blocking: true,
      bound: { rev: 9, head: t("c2d018").head!, proofDigest: proofDigest(fixtureProof(t("c2d018"), now)) },
      landingUrl: "https://forge.example/acme/storefront/pulls/412",
      evidenceIndex: "trails/T-c2d018/evidence/index.json",
      createdAt: iso(now - 35 * MIN),
    }),
    item("7f3a2c", "checkpoint", {
      checkpoint: "A",
      blocking: true,
      evidenceIndex: "trails/T-7f3a2c/evidence/index.json",
      createdAt: iso(now - 50 * MIN),
    }),
    item("91be04", "checkpoint", {
      checkpoint: "B",
      blocking: false,
      shadowVerdict: "approve",
      createdAt: iso(now - 3 * HOUR),
    }),
    item("3a77e1", "spend", { blocking: true, createdAt: iso(now - 20 * MIN) }),
    item("b6620f", "parked", { blocking: false }),
  ];
}

// ───────────────────────── Trail timeline ─────────────────────────

/** Fictional proof for Storybook only; never sent to an Ephyra server. */
export function fixtureProof(trail: Trail, now: number): ProofBundle {
  return {
    schema: 1,
    trail: trail.id,
    rev: trail.rev,
    risk: trail.risk,
    base: trail.base.sha,
    head: trail.head!,
    computedAt: iso(now - 35 * MIN),
    passed: true,
    missing: [],
    env: { runner: "fixture/no-execution" },
    items: [
      {
        kind: "repro_before",
        probe: "cookie-redirect",
        result: "fail",
        log: "Fictional base reproduction output",
      },
      {
        kind: "repro_after",
        probe: "cookie-redirect",
        result: "pass",
        log: "Fictional fixed reproduction output",
      },
      {
        kind: "tests",
        suite: "fixture suite",
        passed: 212,
        failed: 0,
        newFailures: 0,
        log: "Fictional test results",
      },
      { kind: "regression_probes", ran: ["cookie-session"], failed: [] },
    ],
  };
}

export function makeEvents(trail: Trail, now: number): TrailEvent[] {
  const seq: Array<{ at: number; actor: TrailEvent["actor"]; type: string; data: unknown }> = [];
  const add = (at: number, actor: TrailEvent["actor"], type: string, data: unknown) =>
    seq.push({ at, actor, type, data });
  const start = Date.parse(trail.createdAt);
  const agent = (id: string) => ({ kind: "agent" as const, id });
  const human = { kind: "human" as const, id: ME };
  const stages = [
    "triaged",
    "researching",
    "hypothesised",
    "reproducing",
    "planned",
    "patching",
    "proving",
    "ready",
    "watching",
    "closed",
  ];
  const reached = (state: string) =>
    stages.indexOf(trail.state) >= stages.indexOf(state) || ["landing", "parked"].includes(trail.state);
  const hypothesis = `trails/${trail.short}/hypothesis.md`;
  add(start, { kind: "system", id: "ingest" }, "trail_created", {
    signalId: trail.signals[0],
    title: trail.title,
    baseRef: trail.base.ref,
    baseSha: trail.base.sha,
  });
  add(start + 40_000, agent("rho/judgement-jev/jev-1.14"), "triage_completed", {
    result: {
      route: trail.route,
      risk: trail.risk,
      area: trail.area,
      severity: trail.severity,
      actionable: 0.86,
      confidence: { route: 0.82, duplicateOf: 0.93 },
      backends: { extract: "judgement-jev/jev-1.14", decide: "judgement-jev/jev-1.14" },
      reasons: [`area ${trail.area} is ${trail.risk} risk`, "severity above the notify threshold"],
      notifyHuman: trail.severity >= 2.5,
    },
  });
  if (reached("researching"))
    add(start + 12 * MIN, agent("bell/amp-smart"), "research_completed", { hypothesis });
  const { A, B, C } = trail.checkpoints;
  if (A) add(Date.parse(A.at), human, "checkpoint_decided", { checkpoint: "A", decision: A });
  if (reached("planned"))
    add(start + 90 * MIN, agent("lappet/claude-code"), "plan_completed", {
      plan: `trails/${trail.short}/plan.md`,
    });
  if (B)
    add(Date.parse(B.at), { kind: "policy", id: "autonomy.md" }, "checkpoint_decided", {
      checkpoint: "B",
      decision: B,
    });
  if (trail.head && reached("proving"))
    add(start + 150 * MIN, agent("lappet/codex"), "patch_completed", { head: trail.head, revision: 1 });
  if (trail.state === "ready") {
    const bundle = fixtureProof(trail, now);
    add(now - 35 * MIN, agent("nema/fixture"), "proof_completed", { bundle, digest: proofDigest(bundle) });
  }
  if (C) add(Date.parse(C.at), human, "checkpoint_decided", { checkpoint: "C", decision: C });
  if (trail.state === "parked")
    add(now - 70 * HOUR, human, "parked", { reason: "Waiting for the slow-runner pool to be rebuilt." });
  if (trail.pendingSpend)
    add(now - 20 * MIN, agent("lappet/claude-code"), "spend_requested", trail.pendingSpend);
  return seq
    .sort((a, b) => a.at - b.at)
    .map(
      (e, i): TrailEvent =>
        ({
          schema: 1,
          id: uuid(trail.short.slice(2), 1000 + i),
          trail: trail.id,
          rev: e.type === "proof_completed" ? trail.rev : Math.min(trail.rev, i + 1),
          at: iso(e.at),
          actor: e.actor,
          type: e.type,
          data: e.data,
        }) as TrailEvent,
    );
}

// ───────────────────────── Activity ─────────────────────────

export function makeActivity(trails: Trail[], now: number): ActivityItem[] {
  const t = (hex: string) => trails.find((x) => x.short === `T-${hex}`)!;
  const item = (
    id: string,
    persona: PersonaId | null,
    status: ActivityItem["status"],
    summary: string,
    hex: string | null,
    agoMs: number,
    engine: string | null,
    running = false,
  ): ActivityItem => ({
    id,
    at: iso(now - agoMs),
    persona,
    status,
    summary,
    trailId: hex ? t(hex).id : null,
    short: hex ? `T-${hex}` : null,
    engine,
    ...(running ? { startedAt: iso(now - agoMs) } : {}),
  });
  return [
    item(
      "a1",
      "nema",
      "running",
      "Running the full proof for the tax rounding fix",
      "a44d52",
      7 * MIN + 12_000,
      "claude-code/claude-opus-5-5",
      true,
    ),
    item(
      "a2",
      "nema",
      "running",
      "Writing the failing reproduction for the blank second page",
      "58f0aa",
      2 * MIN + 41_000,
      "codex/gpt-6-codex",
      true,
    ),
    item(
      "a3",
      "turri",
      "running",
      "Watching production after the rate limiter landing",
      "0d4c19",
      3 * HOUR + 14 * MIN,
      null,
      true,
    ),
    item(
      "a4",
      "rho",
      "running",
      "Triaging a new checkout error signal",
      null,
      38_000,
      "judgement-jev/jev-1.14",
      true,
    ),
    item(
      "a5",
      "lappet",
      "waiting",
      "Waiting for you to approve a spend before patching",
      "3a77e1",
      20 * MIN,
      "claude-code/claude-opus-5-5",
    ),
    item(
      "a6",
      "bell",
      "done",
      "Wrote the hypothesis for the double coupon failure",
      "7f3a2c",
      50 * MIN,
      "amp/amp-smart",
    ),
    item(
      "a7",
      "nema",
      "done",
      "Proof passed for the Safari cookie fix",
      "c2d018",
      35 * MIN,
      "claude-code/claude-opus-5-5",
    ),
    item(
      "a8",
      "lappet",
      "failed",
      "Patch attempt failed to compile, will retry",
      "3a77e1",
      95 * MIN,
      "codex/gpt-6-codex",
    ),
    item(
      "a9",
      "velum",
      "done",
      "Drafted a billing area for autonomy.md",
      null,
      4 * HOUR,
      "notorganic-chat/velum-1",
    ),
  ];
}

// ───────────────────────── Usage ─────────────────────────

type Template = Omit<UsageEntry, "id" | "idempotencyKey" | "at" | "trailId" | "short"> & {
  hex: string | null;
  costK: number | null;
};

const T = (
  kind: UsageEntry["kind"],
  step: string,
  engine: string,
  billedTo: UsageEntry["billedTo"],
  hex: string | null,
  costK: number | null,
  tokens: number | null,
  wallMs: number | null,
  outcome: UsageEntry["outcome"] = "ok",
  note?: string,
): Template => ({
  kind,
  step,
  engine,
  billedTo,
  hex,
  costK,
  tokens,
  wallMs,
  outcome,
  persona: personaFor(step),
  costMicrousd: null,
  ...(note ? { note } : {}),
});

const JEV = "judgement-jev/jev-1.14";
const OPUS = "claude-code/claude-opus-5-5";
const CODEX = "codex/gpt-6-codex";
const AMP = "amp/amp-smart";
const VELUM = "notorganic-chat/velum-1";

const TEMPLATES: Template[] = [
  T("triage", "triage", JEV, "notorganic", "7f3a2c", 4, 2_400, 900),
  T("extract", "extract", JEV, "notorganic", null, 2, 1_100, 420),
  T("agent_step", "research", AMP, "unknown", "7f3a2c", null, null, 184_000),
  T("agent_step", "research", OPUS, "byok", "91be04", 410, 62_000, 142_000),
  T("agent_step", "plan", OPUS, "byok", "91be04", 230, 31_000, 77_000),
  T("agent_step", "patch", CODEX, "byok", "c2d018", 880, 118_000, 301_000),
  T("agent_step", "repro", OPUS, "byok", "58f0aa", 190, 26_000, 64_000),
  T("agent_step", "review", OPUS, "byok", "c2d018", 140, 19_000, 48_000),
  T("proof", "proof", "runner/devenv-sandbox", "local", "c2d018", 0, null, 412_000),
  T("sandbox", "proof", "runner/devenv-sandbox", "local", "a44d52", 0, null, 233_000),
  T("agent_step", "watch", "turri/watch-probe", "local", "0d4c19", 0, null, 3_600_000),
  T("draft", "draft", VELUM, "notorganic", null, 9, 5_300, 6_200),
  T(
    "agent_step",
    "patch",
    CODEX,
    "byok",
    "3a77e1",
    310,
    45_000,
    118_000,
    "failed",
    "Patch did not compile: type error in refund.ts",
  ),
  T(
    "agent_step",
    "research",
    OPUS,
    "unknown",
    "a44d52",
    null,
    54_000,
    120_000,
    "failed",
    "Agent exited before reporting usage",
  ),
  T(
    "agent_step",
    "patch",
    OPUS,
    "byok",
    "58f0aa",
    null,
    null,
    null,
    "unavailable",
    "Unverified: claude-code is not installed on this runner",
  ),
  T(
    "study",
    "study",
    "voxq/share-link",
    "unknown",
    "7f3a2c",
    null,
    null,
    null,
    "unavailable",
    "Unverified: voxq credentials are not configured",
  ),
  T("agent_step", "land", "forge/trail-ref", "local", "c2d018", 0, null, 5_200),
];

/** Fourteen UTC days of usage ending at `now`, deterministic and never in the future. */
export function makeUsage(trails: Trail[], now: number): UsageEntry[] {
  const out: UsageEntry[] = [];
  const today = Math.floor(now / DAY) * DAY;
  let n = 0;
  for (let d = 13; d >= 0; d--) {
    const dayStart = today - d * DAY;
    const count = 7 + ((d * 5 + 3) % 6) + (d < 7 ? 2 : 0);
    for (let k = 0; k < count; k++) {
      n++;
      const tpl = TEMPLATES[(n * 7 + d) % TEMPLATES.length]!;
      const at = Math.min(now - MIN, dayStart + 7 * HOUR + ((k * 97 + d * 31) % 600) * 60_000 * 0.9);
      const scale = 0.7 + ((n * 13) % 7) / 10;
      const { hex, costK, ...rest } = tpl;
      const trail = hex ? (trails.find((x) => x.short === `T-${hex}`) ?? null) : null;
      out.push({
        ...rest,
        id: `u-${String(n).padStart(4, "0")}`,
        idempotencyKey: `usage:${n}`,
        at: iso(at),
        trailId: trail?.id ?? null,
        short: trail?.short ?? null,
        costMicrousd: costK === null ? null : Math.round(costK * 1000 * scale),
        tokens: rest.tokens === null ? null : Math.round(rest.tokens * scale),
        wallMs: rest.wallMs === null ? null : Math.round(rest.wallMs * scale),
      });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

// ───────────────────────── Policy documents and drafts ─────────────────────────

export const AUTONOMY_MD = `# Autonomy policy

## defaults
mode: shadow                  # shadow | enforce
checkpoints: A=advisory B=advisory C=blocking
landing: trail_ref
watch: 2h
decide: judgement

## area: payments
<!-- level: propose -->
paths: src/payments/**, src/checkout/**
risk: critical
user_facing: true
mode: enforce
checkpoints: A=blocking B=blocking C=blocking
landing: trail_ref
watch: 2h
Checkout and refunds. Money moves here, so nothing lands without a named human approving.

## area: cart
<!-- level: patch -->
paths: src/cart/**
risk: medium
user_facing: true
mode: enforce
checkpoints: A=advisory B=advisory C=blocking
landing: trail_ref
watch: 2h
The basket and coupons. Agents may reproduce and patch; a person approves landing.

## area: marketing-site
<!-- level: auto -->
paths: apps/site/**
risk: low
user_facing: true
mode: enforce
checkpoints: A=advisory B=advisory C=advisory
landing: trail_ref, devenv_live, auto_land
watch: 1h
The public site. Loose edge: small fixes can land alone and roll back on any new error.
`;

export const THRESHOLDS_YAML = `"judgement-jev/jev-1.14":
  duplicate: 0.7
  regression: 0.7
  conflict: 0.6
  actionable: 0.4
  ignore: 0.8
  severity: 2.5
  confidence: 0.5
`;

const intent = (name: string, body: string) => `# Intent: ${name}\n\n${body}\n`;

export function makeDocs(): PolicyDoc[] {
  const docs: Array<Omit<PolicyDoc, "digest">> = [
    { path: "autonomy.md", kind: "autonomy", content: AUTONOMY_MD, warnings: [] },
    { path: "thresholds.yaml", kind: "thresholds", content: THRESHOLDS_YAML, warnings: [] },
    {
      path: "intents/checkout-flow.md",
      kind: "intent",
      content: intent(
        "Checkout flow",
        "A signed-in shopper can pay with a saved card in three taps.\nA coupon applies at most once per order.",
      ),
      warnings: [],
    },
    {
      path: "intents/search.md",
      kind: "intent",
      content: intent(
        "Search",
        "Results page through in order and the last page is never empty.\nUnknown filters are ignored, not errors.",
      ),
      warnings: ["line 4: unknown key faceted"],
    },
  ];
  return docs.map((d) => ({ ...d, digest: fakeDigest(d.content) }));
}

export const emptyDraft = (id: string, doc: PolicyDoc, now: number, by = ME): Draft => ({
  id,
  path: doc.path,
  kind: doc.kind,
  baseDigest: doc.digest,
  content: doc.content,
  warnings: doc.warnings,
  status: "open",
  createdBy: by,
  createdAt: iso(now - 40 * MIN),
  updatedAt: iso(now - 40 * MIN),
  messages: [],
});

export const PERSONA_IDS = PERSONAS.map((p) => p.id);
