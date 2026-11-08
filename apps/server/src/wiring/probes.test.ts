import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReconciliationRequired, Trail, TrailEvent, Unverified, proofDigest, type ProofBundle, type RunnerHandle } from "@ephyra/core";
import { GitJournal } from "@ephyra/journal";
import { LocalRunner } from "@ephyra/runner";
import { MemorySignalStore } from "@ephyra/ingest";
import { AUTONOMY_TEMPLATE, THRESHOLDS_TEMPLATE, parseAutonomy, parseThresholds } from "@ephyra/policy";
import { MemoryOperationLedger } from "../orchestrator/effects.ts";
import { FakeContext } from "./context.ts";
import { Engine } from "./runtime.ts";
import { MemoryStore } from "./store.ts";
import type { EffectHandlers } from "../orchestrator.ts";
import type { Git } from "./landing.ts";
import { GitProbeCatalog, assertHarnessUnchanged, executeProbe, harnessPaths, probeApplies, probeHandlers, selfContainedShell } from "./probes.ts";
import { createVerificationCollector, repositoryVerificationCommands } from "./verification.ts";

const now = "2026-11-08T12:00:00.000Z";
const id = "00000000-0000-4000-8000-000000000001";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-probes-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const invoke = async (args: string[], input?: string, extra?: Record<string, string>) => {
    const child = Bun.spawn(["git", ...args], { cwd: directory, env: { ...env, ...extra },
      stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(stderr);
    return stdout;
  };
  await invoke(["init", "-q", "--initial-branch=main"]);
  await mkdir(join(directory, "src")); await mkdir(join(directory, "intents"));
  const intent = "---\nid: application\narea: application\npaths: [src/**]\nprobes:\n"
    + "  - kind: script\n    id: completes\n    command: [sh, -c, 'test -f src/value.ts']\n---\nThe value exists.\n";
  await writeFile(join(directory, "src/value.ts"), "export const value = 1;\n");
  await writeFile(join(directory, "intents/application.md"), intent);
  await invoke(["add", "."]); await invoke(["commit", "-qm", "base"]);
  const base = (await invoke(["rev-parse", "HEAD"])).trim();
  await writeFile(join(directory, "src/value.ts"), "export const value = 2;\n");
  await invoke(["add", "."]); await invoke(["commit", "-qm", "head"]);
  const head = (await invoke(["rev-parse", "HEAD"])).trim();
  const git: Git = (args, opts) => invoke(["--git-dir", join(directory, ".git"), ...args], opts?.input, opts?.env);
  const journal = new GitJournal({ gitDir: join(directory, ".git"), clock: { now: () => new Date(now) } });
  const trail = Trail.parse({ schema: 1, id, short: "T-fixture", repo: "fixture", title: "Fixture value", rev: 1,
    state: "closed", signals: [], area: "application", risk: "low", route: "auto_fix", severity: 1,
    base: { ref: "refs/heads/main", sha: base }, head, checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
    budget: { tokensUsed: 0, tokensMax: 100, wallclockMaxS: 300, spendMicrousdUsed: 0, spendMicrousdMax: 0 },
    mirrors: {}, createdAt: now, updatedAt: now });
  const script = "#!/bin/sh\ntest -f src/value.ts\n";
  const proof: ProofBundle = { schema: 1, trail: id, rev: 1, base, head, risk: "low", items: [
    { kind: "repro_before", probe: ".ephyra/repro/value.sh", result: "fail", log: "fixture observed base failure" },
    { kind: "repro_after", probe: ".ephyra/repro/value.sh", result: "pass", log: "fixture observed head pass" },
    { kind: "tests", suite: "fixture", passed: 1, failed: 0, newFailures: 0, log: "fixture report" },
    { kind: "diff_scope", files: 1, lines: 2, paths: ["src/value.ts"], exportedTypesChanged: false },
  ], passed: true, missing: [], env: { runner: "fixture" }, computedAt: now };
  const event = TrailEvent.parse({ schema: 1, id: crypto.randomUUID(), trail: id, rev: 1, at: now,
    actor: { kind: "system", id: "proof" }, type: "proof_completed", data: { bundle: proof, digest: proofDigest(proof) } });
  await journal.create(trail, event, { "proof/manifest.json": JSON.stringify(proof), ".ephyra/repro/value.sh": script });
  const ctx = new FakeContext({ id: "fixture", url: directory, mirrorDir: join(directory, ".git"),
    baseRef: "refs/heads/main", forge: "plain", remote: "origin" },
  { autonomy: parseAutonomy(AUTONOMY_TEMPLATE), thresholds: parseThresholds(THRESHOLDS_TEMPLATE) }, journal, new MemorySignalStore());
  ctx.put(trail);
  return { directory, trail, proof, journal, git, ctx, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function studyContext(f: Awaited<ReturnType<typeof fixture>>, max = 100) {
  const trail = { ...f.trail, state: "proving" as const, budget: { ...f.trail.budget, spendMicrousdMax: max },
    checkpoints: { spend: [{ by: "human" as const, who: "did:fixture:owner", at: now, verdict: "approve" as const }] } };
  const current = (await f.journal.read(id))!;
  await f.journal.append(id, current.head, trail, []);
  const store = new MemoryStore(); await store.putTrail(trail);
  const engine = new Engine(store, f.journal, new MemoryOperationLedger(), async () => ({ now: new Date().toISOString(),
    blocking: { A: true, B: true, C: true }, landingModes: ["trail_ref"] }), { uuidv7: () => crypto.randomUUID() }, () => {});
  engine.setHandlers({ notify_inbox: async () => {}, stop_agent: async () => {} } as unknown as EffectHandlers);
  f.ctx.trails = { get: id => store.getTrail(id), list: filter => store.listTrails(filter?.states), events: id => store.events(id) };
  f.ctx.emit = async input => { f.ctx.emitted.push(input); await engine.emit(input); };
  return trail;
}

test("closed successful repro registration survives catalog recreation and is immutable/idempotent", async () => {
  const f = await fixture();
  try {
    const catalog = new GitProbeCatalog({ git: f.git, journal: f.journal });
    const probe = await catalog.registerClosedTrail(f.trail);
    expect(probe.source).toMatchObject({ commit: f.trail.head, trailId: id, proofDigest: proofDigest(f.proof) });
    expect(await catalog.registerClosedTrail(f.trail)).toEqual(probe);
    const current = (await f.journal.read(id))!;
    await f.journal.append(id, current.head, f.trail, [], { ".ephyra/repro/value.sh": "exit 99\n" });
    expect(await catalog.registerClosedTrail(f.trail)).toEqual(probe);
    const recreated = new GitProbeCatalog({ git: f.git, journal: f.journal });
    expect(await recreated.list(f.trail, "regression")).toEqual([probe]);
    const intents = await recreated.list(f.trail, "intent");
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ id: "intent:application:completes", command: ["sh", "-c", "test -f src/value.ts"],
      source: { commit: f.trail.base.sha, path: "intents/application.md" } });
  } finally { await f.cleanup(); }
});

test("a repository-defined intent command really executes in an isolated local checkout and records its outcome", async () => {
  const f = await fixture();
  const runner = new LocalRunner(join(f.directory, "runner"), { trusted: true });
  let handle: Awaited<ReturnType<typeof runner.allocate>> | undefined;
  try {
    const catalog = new GitProbeCatalog({ git: f.git, journal: f.journal });
    const probe = (await catalog.list(f.trail, "intent"))[0]!;
    handle = await runner.allocate({ trail: f.trail, attempt: 1, repoUrl: f.directory, commit: f.trail.head!,
      profile: { name: "fixture", digest: "fixture", network: "egress", readOnlyProd: true, credentials: [],
        limits: { cpu: 1, memoryMb: 100, diskMb: 100, timeoutS: 30 } } });
    const receipt = await executeProbe(probe, { runner, handle, remainingMs: () => 5000 });
    expect(receipt).toMatchObject({ id: probe.id, result: "pass", exit: 0, source: probe.source });
    const failed = await executeProbe({ ...probe, command: ["sh", "-c", "exit 7"] }, { runner, handle, remainingMs: () => 5000 });
    expect(failed).toMatchObject({ result: "fail", exit: 7 });
  } finally {
    if (handle) await runner.destroy(handle);
    await f.cleanup();
  }
});

test("registration refuses an open trail, mismatched proof or altered successful script", async () => {
  const f = await fixture();
  try {
    const catalog = new GitProbeCatalog({ git: f.git, journal: f.journal });
    await expect(catalog.registerClosedTrail({ ...f.trail, rev: 2 })).rejects.toBeInstanceOf(Unverified);
    const snapshot = (await f.journal.read(id))!;
    await f.journal.append(id, snapshot.head, f.trail, [], { "proof/manifest.json": JSON.stringify({ ...f.proof, head: f.trail.base.sha }) });
    await expect(catalog.registerClosedTrail(f.trail)).rejects.toBeInstanceOf(Unverified);
  } finally { await f.cleanup(); }
});

test("probe applicability cannot cross a declared area and unrelated changed files cannot select a scoped probe", () => {
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 30 }), fc.string({ minLength: 1, maxLength: 30 }), (a, b) => {
    fc.pre(a !== b);
    expect(probeApplies({ area: a, paths: [] }, b, ["src/value.ts"])).toBe(false);
  }));
  expect(probeApplies({ area: "application", paths: ["src/**"] }, "application", ["other/value.ts"])).toBe(false);
  expect(probeApplies({ area: "application", paths: ["src/**"] }, "application", ["src/value.ts"])).toBe(true);
});

test("immutable inline shell remains supported while external verifiers must declare their protected closure", () => {
  expect(selfContainedShell("test -f src/value.ts && printf 'observed'\n")).toBe(true);
  fc.assert(fc.property(fc.string(), text => {
    expect(selfContainedShell(`test -f src/value.ts && echo $(sh ${JSON.stringify(text)})`)).toBe(false);
  }));
  expect(() => harnessPaths({ command: ["sh", "scripts/check.sh"] })).toThrow("protectedPaths");
  const declaration = { command: ["sh", "scripts/check.sh"], protectedPaths: ["scripts/helper.sh"], sourcePath: "intents/application.md" };
  for (const changed of ["scripts/check.sh", "scripts/helper.sh", "intents/application.md"]) {
    expect(() => assertHarnessUnchanged(declaration, [changed])).toThrow("dependency closure");
  }
  expect(() => assertHarnessUnchanged({ command: ["sh", "check"], protectedPaths: ["helper"] }, ["check"]))
    .toThrow("dependency closure");
  expect(() => assertHarnessUnchanged(declaration, ["src/value.ts"])).not.toThrow();
});

async function acceptedHarness(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(join(f.directory, "scripts")); await mkdir(join(f.directory, ".ephyra"));
  await writeFile(join(f.directory, ".gitignore"), "scripts/generated/\nrunner/\n");
  await writeFile(join(f.directory, "scripts/check.sh"), "sh scripts/helper.sh\n");
  await writeFile(join(f.directory, "scripts/helper.sh"), "exit 1\n");
  await writeFile(join(f.directory, "scripts/report.sh"), "echo 'actual renderer unavailable'\n");
  await writeFile(join(f.directory, "intents/application.md"), "---\nid: application\narea: application\nprobes:\n"
    + "  - kind: script\n    command: [sh, scripts/check.sh]\n    protectedPaths: [scripts/**]\n---\nAccepted product intent.\n");
  await writeFile(join(f.directory, ".ephyra/proof.json"), JSON.stringify({ schema: 1, commands: [{ id: "stories",
    command: ["sh", "scripts/report.sh"], protectedPaths: ["scripts/helper.sh"], kinds: ["story_render"] }] }));
  await f.git(["add", "."]); await f.git(["commit", "-qm", "accepted verifier closure"]);
  const base = (await f.git(["rev-parse", "HEAD"])).trim();
  return { ...f.trail, base: { ...f.trail.base, sha: base }, head: base };
}

test("a candidate cannot replace accepted intent or UI reporter bodies while keeping their argv unchanged", async () => {
  const f = await fixture();
  try {
    const accepted = await acceptedHarness(f);
    await writeFile(join(f.directory, "scripts/check.sh"), "exit 0\n");
    await writeFile(join(f.directory, "scripts/report.sh"), "echo '{\"items\":[{\"kind\":\"story_render\",\"stories\":[\"never-rendered\"]}]}'\n");
    await f.git(["add", "."]); await f.git(["commit", "-qm", "candidate attempts verifier replacement"]);
    const candidate = { ...accepted, head: (await f.git(["rev-parse", "HEAD"])).trim() };
    const catalog = new GitProbeCatalog({ git: f.git, journal: f.journal });
    await expect(catalog.list(candidate, "intent")).rejects.toThrow("dependency closure");
    await expect(repositoryVerificationCommands(f.git, candidate)).rejects.toThrow("dependency closure");
  } finally { await f.cleanup(); }
});

test("prepared-tree integrity detects dirty or ignored verifier dependencies before any claimed passing execution", async () => {
  const f = await fixture();
  const runner = new LocalRunner(join(f.directory, "runner"), { trusted: true });
  let handle: RunnerHandle | undefined;
  try {
    const accepted = await acceptedHarness(f);
    const catalog = new GitProbeCatalog({ git: f.git, journal: f.journal });
    const probe = (await catalog.list(accepted, "intent"))[0]!;
    handle = await runner.allocate({ trail: accepted, attempt: 1, repoUrl: f.directory, commit: accepted.head!,
      profile: { name: "fixture", digest: "fixture", network: "egress", readOnlyProd: true, credentials: [],
        limits: { cpu: 1, memoryMb: 100, diskMb: 100, timeoutS: 30 } } });
    expect(await executeProbe(probe, { runner, handle, remainingMs: () => 5000 })).toMatchObject({ result: "fail", exit: 1 });
    await runner.writeFile(handle, "scripts/helper.sh", "exit 0\n");
    await expect(executeProbe(probe, { runner, handle, remainingMs: () => 5000 })).rejects.toThrow("dependency closure");
    await runner.writeFile(handle, "scripts/helper.sh", "exit 1\n");
    await runner.writeFile(handle, "scripts/generated/hidden.sh", "exit 0\n");
    await expect(executeProbe(probe, { runner, handle, remainingMs: () => 5000 })).rejects.toThrow("dependency closure");
  } finally {
    if (handle) await runner.destroy(handle);
    await f.cleanup();
  }
});

test("missing executable probes and unconfigured respondent delivery park before any paid dispatch", async () => {
  const f = await fixture();
  try {
    const active = { ...f.trail, state: "proving" as const }; f.ctx.put(active);
    const handlers = probeHandlers(f.ctx, { catalog: new GitProbeCatalog({ git: f.git, journal: f.journal }),
      ledger: new MemoryOperationLedger() });
    await handlers.run_probes!({ type: "run_probes", key: "intent", probes: ["unknown"], reason: "Intent changed" }, active);
    expect(f.ctx.emitted.at(-1)).toMatchObject({ type: "parked" });
    await handlers.start_respondent_run!({ type: "start_respondent_run", key: "study", purpose: "clarity", microusd: 100 }, active);
    expect(f.ctx.emitted.at(-1)).toMatchObject({ type: "parked" });
  } finally { await f.cleanup(); }
});

test("human study dispatch is named, bounded and durable; uncertain publication never dispatches twice", async () => {
  for (const uncertain of [false, true]) {
    const f = await fixture();
    try {
      const ledger = new MemoryOperationLedger();
      let calls = 0;
      const trail = await studyContext(f);
      const handlers = probeHandlers(f.ctx, { catalog: new GitProbeCatalog({ git: f.git, journal: f.journal }), ledger,
        respondents: async request => {
          calls++;
          expect(request.maxMicrousd).toBe(100); expect(request.operationKey).toContain("respondents:");
          if (uncertain) throw new Error("fixture lost acknowledgment");
          return { trailId: trail.id, rev: trail.rev, head: trail.head!, item: { kind: "voxq_study", study: "fixture-study",
            runId: "fixture-completed-run", respondents: 2, via: "share_link", spendMicrousd: 80, expectMet: true, report: "fixture export" } };
        } });
      const effect = { type: "start_respondent_run" as const, key: `study-${uncertain}`, purpose: "clarity", microusd: 100 };
      if (uncertain) {
        await expect(handlers.start_respondent_run!(effect, trail)).rejects.toBeInstanceOf(ReconciliationRequired);
        await expect(handlers.start_respondent_run!(effect, trail)).rejects.toBeInstanceOf(ReconciliationRequired);
      } else {
        await handlers.start_respondent_run!(effect, trail);
        await handlers.start_respondent_run!(effect, trail);
        expect((await f.ctx.trails.get(id))!.budget.spendMicrousdUsed).toBe(80);
        const collect = createVerificationCollector({ catalog: { list: async () => [] }, journal: f.journal });
        const context = { trail, base: trail.base.sha, head: trail.head!, runner: {} as LocalRunner,
          handle: {} as RunnerHandle, baseCwd: ".base", headCwd: ".head", remainingMs: () => 1000, items: [] };
        expect(await collect(context)).toMatchObject([{ kind: "voxq_study", runId: "fixture-completed-run", spendMicrousd: 80 }]);
        expect(await collect({ ...context, trail: { ...trail, rev: trail.rev + 1 } })).toEqual([]);
      }
      expect(calls).toBe(1);
    } finally { await f.cleanup(); }
  }
});

test("remaining spend and the durable in-flight reservation prevent overlapping human studies", async () => {
  const f = await fixture();
  try {
    const trail = await studyContext(f);
    let calls = 0;
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    const handlers = probeHandlers(f.ctx, { catalog: new GitProbeCatalog({ git: f.git, journal: f.journal }),
      ledger: new MemoryOperationLedger(), respondents: async () => {
        calls++; started(); await waiting;
        return { trailId: id, rev: trail.rev, head: trail.head!, item: { kind: "voxq_study", study: "fixture-study",
          runId: "fixture-run", respondents: 1, via: "share_link", spendMicrousd: 80, expectMet: true, report: "fixture" } };
      } });
    const effect = { type: "start_respondent_run" as const, key: "first-study", purpose: "clarity", microusd: 100 };
    const pending = handlers.start_respondent_run!(effect, trail);
    await dispatched;
    await handlers.start_respondent_run!({ ...effect, key: "overlapping-study" }, trail);
    expect(calls).toBe(1);
    release(); await pending;
    expect((await f.ctx.trails.get(id))!.budget.spendMicrousdUsed).toBe(80);
    await handlers.start_respondent_run!({ ...effect, key: "above-remaining-budget" }, trail);
    expect(calls).toBe(1);
  } finally { await f.cleanup(); }
});

test("over-limit provider spending is charged once and cannot become proof or dispatch again", async () => {
  const f = await fixture();
  try {
    const trail = await studyContext(f);
    let calls = 0;
    const handlers = probeHandlers(f.ctx, { catalog: new GitProbeCatalog({ git: f.git, journal: f.journal }),
      ledger: new MemoryOperationLedger(), respondents: async () => {
        calls++;
        return { trailId: id, rev: trail.rev, head: trail.head!, item: { kind: "voxq_study", study: "fixture-study",
          runId: "fixture-run", respondents: 1, via: "share_link", spendMicrousd: 120, expectMet: true, report: "fixture" } };
      } });
    const effect = { type: "start_respondent_run" as const, key: "over-limit-study", purpose: "clarity", microusd: 100 };
    await handlers.start_respondent_run!(effect, trail); await handlers.start_respondent_run!(effect, trail);
    expect(calls).toBe(1);
    expect((await f.ctx.trails.get(id))!.budget.spendMicrousdUsed).toBe(120);
    expect(await f.journal.readFile(id, "evidence/respondents/index.json")).toBeNull();
  } finally { await f.cleanup(); }
});

test("unknown respondent spend is unreconciled, never evidence or permission for a second dispatch", async () => {
  const f = await fixture();
  try {
    const trail = await studyContext(f);
    let calls = 0;
    const handlers = probeHandlers(f.ctx, { catalog: new GitProbeCatalog({ git: f.git, journal: f.journal }),
      ledger: new MemoryOperationLedger(), respondents: async () => {
        calls++;
        return { trailId: id, rev: trail.rev, head: trail.head!, item: { kind: "voxq_study", study: "fixture-study",
          runId: "fixture-run", respondents: 1, via: "share_link", spendMicrousd: null as unknown as number,
          expectMet: true, report: "fixture missing actual spend" } };
      } });
    const effect = { type: "start_respondent_run" as const, key: "unknown-study", purpose: "clarity", microusd: 100 };
    await expect(handlers.start_respondent_run!(effect, trail)).rejects.toBeInstanceOf(ReconciliationRequired);
    await expect(handlers.start_respondent_run!(effect, trail)).rejects.toBeInstanceOf(ReconciliationRequired);
    expect(calls).toBe(1);
    expect((await f.ctx.trails.get(id))!.budget.unknownCostEntries).toBe(1);
    expect(await f.journal.readFile(id, "evidence/respondents/index.json")).toBeNull();
  } finally { await f.cleanup(); }
});

test("child evidence must belong to this parent and match the child's exact final proof", async () => {
  const f = await fixture();
  try {
    const parent = { ...f.trail, id: "00000000-0000-4000-8000-000000000002", state: "parked" as const };
    const initial = TrailEvent.parse({ schema: 1, id: crypto.randomUUID(), trail: parent.id, rev: parent.rev, at: now,
      actor: { kind: "human", id: "owner" }, type: "human_comment", data: { text: "fixture parent", isRequest: false } });
    await f.journal.create(parent, initial);
    const handlers = probeHandlers(f.ctx, { catalog: new GitProbeCatalog({ git: f.git, journal: f.journal }),
      ledger: new MemoryOperationLedger() });
    const effect = { type: "deliver_child_evidence" as const, key: "child", child: id, proofDigest: proofDigest(f.proof) };
    await expect(handlers.deliver_child_evidence!(effect, parent)).rejects.toBeInstanceOf(Unverified);
    const child = (await f.journal.read(id))!;
    await f.journal.append(id, child.head, { ...f.trail, parent: parent.id }, []);
    await handlers.deliver_child_evidence!(effect, parent);
    const bytes = await f.journal.readFile(parent.id, `evidence/children/${id}-1.json`);
    expect(JSON.parse(new TextDecoder().decode(bytes!))).toMatchObject({ child: id, rev: 1, proofDigest: proofDigest(f.proof) });
    await expect(handlers.deliver_child_evidence!({ ...effect, proofDigest: `sha256:${"0".repeat(64)}` }, parent))
      .rejects.toBeInstanceOf(Unverified);
  } finally { await f.cleanup(); }
});
