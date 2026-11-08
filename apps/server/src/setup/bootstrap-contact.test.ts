import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ReconciliationRequired, type Journal, type OperationLedger, type PeopleConnection, type SetupRun } from "@ephyra/core";
import { MemorySignalStore } from "@ephyra/ingest";
import { AUTONOMY_TEMPLATE, THRESHOLDS_TEMPLATE, parseAutonomy, parseThresholds } from "@ephyra/policy";
import { MemoryOperationLedger } from "../orchestrator/effects.ts";
import { FakeContext } from "../wiring/context.ts";
import type { Fetch } from "../auth/crypto.ts";
import { BootstrapContact } from "./bootstrap-contact.ts";
import { AutomaticSetup, setupGit } from "./automation.ts";

const at = "2026-11-08T12:00:00.000Z";
const did = "did:plc:owner";
const workspaceId = "ws-bootstrap-contact";
const token = "bootstrap-delivery-fixture-secret";
const contextId = "c".repeat(64);
const configId = "d".repeat(64);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function fixture(ledger: OperationLedger = new MemoryOperationLedger(), timeoutMs = 1000) {
  const ctx = new FakeContext({ id: workspaceId, url: "https://git.example.org/team/project.git", mirrorDir: "/unused",
    baseRef: "main", forge: "plain", remote: "origin" }, {
    autonomy: parseAutonomy(AUTONOMY_TEMPLATE), thresholds: parseThresholds(THRESHOLDS_TEMPLATE),
  }, {} as Journal, new MemorySignalStore(), { now: () => new Date(at) });
  let run: SetupRun | null = {
    id: "a".repeat(32), mode: "supervised", status: "blocked", startedAt: at, updatedAt: at,
    repository: { url: ctx.repo.url, branch: "main", head: "b".repeat(40) }, steps: [], blockers: [], artifacts: [],
    bootstrap: { schema: 1, setupId: "a".repeat(32), head: "b".repeat(40), assessedAt: at,
      nextAssessmentAt: "2026-11-08T12:05:00.000Z", sources: [], coverage: [], contextReports: [], requests: [
        { id: contextId, kind: "context", status: "open", question: `Which journey matters? ${token}`,
          action: "Give a factual example.", options: [], createdAt: at, updatedAt: at },
        { id: configId, kind: "configuration", gap: "runner", status: "open", question: "A runner is missing.",
          action: "Connect an isolated runner.", options: [], createdAt: at, updatedAt: at },
      ] },
  };
  let connection: { settings: PeopleConnection; token?: string } | null = {
    token, settings: { enabled: true, workspaceId, contacts: [
      { id: "workspace-owner", alias: "Owner", roles: ["maintainer", "operator"], areas: [], did },
      { id: "other-person", alias: "Other", roles: ["maintainer"], areas: [], did: "did:plc:other" },
    ], webhookUrl: "https://bridge.example.org/ephyra", keyConfigured: true, updatedAt: at },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  let fetcher: Fetch = async () => new Response(null, { status: 204 });
  let connectionReads = 0;
  let beforeConnection: (() => void) | undefined;
  const options = { ctx, ledger, did, workspaceId, timeoutMs, current: async () => structuredClone(run),
    connection: async () => { connectionReads++; beforeConnection?.(); return structuredClone(connection); },
    publicOrigin: "https://console.example.org",
    fetcher: async (url: string, init?: RequestInit) => { calls.push({ url, init: init ?? {} }); return fetcher(url, init); },
  };
  const service = new BootstrapContact(options);
  const scheduled = () => ctx.queued.filter((job) => job.kind === "bootstrap_contact");
  const deliver = async (index = 0) => {
    const job = scheduled()[index]!;
    expect(job).toBeDefined();
    await ctx.jobRunners.get(job.kind)!(job.payload, { key: job.key, attempt: 1 });
    return job;
  };
  return { ctx, service, ledger, calls, options, scheduled, deliver,
    run: () => run!, settings: () => connection!.settings,
    current: (value: SetupRun | null) => { run = value; },
    connection: (value: typeof connection) => { connection = value; },
    respond: (value: Fetch) => { fetcher = value; },
    beforeConnection: (value: () => void) => { beforeConnection = value; },
    reads: () => connectionReads,
  };
}

test("bootstrap schedules one bundled owner notice and persists the actual bridge acknowledgement without secrets", async () => {
  const f = fixture();
  await f.service.schedule(f.run());
  await f.service.schedule(f.run());
  expect(f.calls).toHaveLength(0);
  expect(f.scheduled()).toHaveLength(1);
  const jobText = JSON.stringify(f.scheduled());
  expect(jobText).not.toContain(token);
  expect(jobText).not.toContain("bridge.example.org");
  expect(jobText).not.toContain("Which journey matters");
  const job = await f.deliver();
  expect(f.calls).toHaveLength(1);
  const sent = f.calls[0]!;
  const headers = new Headers(sent.init.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(headers.get("idempotency-key")).toBe(job.key);
  expect(sent.init.redirect).toBe("error");
  expect(sent.init.credentials).toBe("omit");
  const body = JSON.parse(String(sent.init.body));
  expect(body).toMatchObject({ type: "ephyra.bootstrap.request", workspaceId, setupId: f.run().id,
    head: f.run().repository.head, recipient: "workspace-owner", inboxUrl: "https://console.example.org/app/#/inbox" });
  expect(body.requestIds).toEqual([contextId, configId]);
  expect(body.requests).toHaveLength(2);
  expect(JSON.stringify(body)).not.toContain(token);
  const receipt = await f.ledger.get(job.key);
  expect(receipt).toMatchObject({ status: "done", result: { status: "acknowledged", receipt: "http:204",
    setupId: f.run().id, head: f.run().repository.head, requestIds: [contextId, configId], recipient: "workspace-owner" } });
  expect((receipt!.result as { payloadDigest: string }).payloadDigest)
    .toBe(createHash("sha256").update(String(sent.init.body)).digest("hex"));
  expect(JSON.stringify(receipt)).not.toContain(token);
  expect(JSON.stringify(receipt)).not.toContain("bridge.example.org");
  await f.deliver();
  new BootstrapContact(f.options);
  await f.deliver();
  expect(f.calls).toHaveLength(1);
});

test("the default Inbox, disabled settings, wrong workspace and other recipients never enqueue external delivery", async () => {
  const variants = [
    (f: ReturnType<typeof fixture>) => { f.settings().webhookUrl = null; f.settings().keyConfigured = false; },
    (f: ReturnType<typeof fixture>) => { f.settings().enabled = false; },
    (f: ReturnType<typeof fixture>) => { f.settings().workspaceId = "other-workspace"; },
    (f: ReturnType<typeof fixture>) => { f.settings().contacts = f.settings().contacts.filter((person) => person.did !== did); },
    (f: ReturnType<typeof fixture>) => { f.connection(null); },
    (f: ReturnType<typeof fixture>) => { f.run().bootstrap!.requests.forEach((request) => { request.status = "answered"; }); },
  ];
  for (const change of variants) {
    const f = fixture(); change(f);
    await f.service.schedule(f.run());
    expect(f.scheduled()).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  }
});

test("owner area scopes filter the bundle and unchanged assessments cannot produce repeat notices", async () => {
  const f = fixture();
  f.settings().contacts[0]!.areas = ["application"];
  await f.service.schedule(f.run());
  await f.deliver();
  expect(JSON.parse(String(f.calls[0]!.init.body)).requestIds).toEqual([contextId]);
  f.run().bootstrap!.assessedAt = "2026-11-08T12:05:00.000Z";
  await f.service.schedule(f.run());
  expect(f.scheduled()).toHaveLength(1);
  f.settings().contacts[0]!.areas = ["unrelated-area"];
  await f.service.schedule(f.run());
  expect(f.scheduled()).toHaveLength(1);
  f.settings().contacts[0]!.areas = ["setup"];
  f.settings().updatedAt = "2026-11-08T12:10:00.000Z";
  await f.service.schedule(f.run());
  expect(f.scheduled()).toHaveLength(2);
  await f.deliver(1);
  expect(JSON.parse(String(f.calls[1]!.init.body)).requestIds).toEqual([contextId, configId]);
});

test("a stale setup, answered request, revoked owner or changed token blocks dispatch before any network write", async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => { f.run().repository.head = "e".repeat(40); },
    (f: ReturnType<typeof fixture>) => { f.run().bootstrap!.requests[0]!.status = "answered"; },
    (f: ReturnType<typeof fixture>) => { f.settings().contacts[0]!.did = "did:plc:replacement"; },
    (f: ReturnType<typeof fixture>) => { f.current(null); },
    (f: ReturnType<typeof fixture>) => { f.run().blockers.push({ id: "base_changed", summary: "Moved base",
      action: "Run setup against the current commit.", owner: "maintainer" }); },
  ];
  for (const change of changes) {
    const f = fixture(); await f.service.schedule(f.run()); change(f);
    await expect(f.deliver()).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  }
  const f = fixture();
  await f.service.schedule(f.run());
  f.beforeConnection(() => {
    // schedule=1; initial job authority=2; after the durable claim=3.
    if (f.reads() === 3) f.connection({ settings: f.settings(), token: "replacement-token" });
  });
  await expect(f.deliver()).rejects.toBeInstanceOf(ReconciliationRequired);
  expect(f.calls).toHaveLength(0);
  expect((await f.ledger.get(f.scheduled()[0]!.key))!.status).toBe("reconciliation_required");
});

test("ambiguous delivery and failed receipt saving survive a new service without blind replay", async () => {
  for (const failure of ["timeout", "receipt-save", "authority-change", "non-acknowledgement"] as const) {
    const inner = new MemoryOperationLedger();
    const ledger: OperationLedger = {
      begin: (key, digest) => inner.begin(key, digest), get: (key) => inner.get(key),
      complete: async (key, value) => {
        if (failure === "receipt-save") throw new Error("Storage unavailable");
        await inner.complete(key, value);
      },
      markAmbiguous: (key, note) => inner.markAmbiguous(key, note),
    };
    const f = fixture(ledger, 5);
    let release: ((response: Response) => void) | undefined;
    f.respond(async () => {
      if (failure === "timeout") return new Promise((resolve) => { release = resolve; });
      if (failure === "authority-change") f.settings().updatedAt = "2026-11-08T12:15:00.000Z";
      return new Response(null, { status: failure === "non-acknowledgement" ? 500 : 202 });
    });
    await f.service.schedule(f.run());
    await expect(f.deliver()).rejects.toBeInstanceOf(ReconciliationRequired);
    expect(f.calls).toHaveLength(1);
    const key = f.scheduled()[0]!.key;
    expect((await inner.get(key))!.status).toBe("reconciliation_required");
    release?.(new Response(null, { status: 204 }));
    await Promise.resolve();
    await Promise.resolve();
    new BootstrapContact(f.options);
    await expect(f.deliver()).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
    expect((await inner.get(key))!.status).toBe("reconciliation_required");
  }
});

test("a pending ledger boundary and an invalid saved receipt never dispatch again", async () => {
  for (const done of [false, true]) {
    const inner = new MemoryOperationLedger();
    const f = fixture(inner);
    await f.service.schedule(f.run());
    // Capture the actual operation digest from the first attempted delivery without sending a request.
    const original = inner.begin.bind(inner);
    inner.begin = async (key, digest) => {
      await original(key, digest);
      if (done) await inner.complete(key, { receipt: "invented" });
      return { fresh: false, record: (await inner.get(key))! };
    };
    await expect(f.deliver()).rejects.toBeInstanceOf(ReconciliationRequired);
    expect(f.calls).toHaveLength(0);
    expect((await inner.get(f.scheduled()[0]!.key))!.status).toBe(done ? "done" : "pending");
  }
});

test("a lost receipt-save response reuses the persisted acknowledgement after restart instead of sending again", async () => {
  const inner = new MemoryOperationLedger();
  let saves = 0;
  const ledger: OperationLedger = {
    begin: (key, digest) => inner.begin(key, digest), get: (key) => inner.get(key),
    markAmbiguous: (key, note) => inner.markAmbiguous(key, note),
    complete: async (key, value) => { saves++; await inner.complete(key, value); throw new Error("The save response was lost."); },
  };
  const f = fixture(ledger);
  await f.service.schedule(f.run());
  await expect(f.deliver()).rejects.toBeInstanceOf(ReconciliationRequired);
  const key = f.scheduled()[0]!.key;
  expect((await inner.get(key))!.status).toBe("done");
  new BootstrapContact(f.options);
  await f.deliver();
  expect(f.calls).toHaveLength(1);
  expect(saves).toBe(1);
  expect((await inner.get(key))!.status).toBe("done");
});

test("assessment hooks observe durable initial, refreshed, answered and reported records; scheduling failure leaves the Inbox intact", async () => {
  const f = fixture();
  const directory = await mkdtemp(join(tmpdir(), "ephyra-bootstrap-contact-hook-"));
  directories.push(directory);
  const init = Bun.spawn(["git", "init", "--bare", "--quiet", directory], { stdout: "ignore", stderr: "ignore" });
  expect(await init.exited).toBe(0);
  const git = setupGit(directory);
  const tree = (await git(["mktree"], { input: "" })).trim();
  const head = (await git(["commit-tree", tree, "-m", "Offline fixture"])).trim();
  await git(["update-ref", "refs/heads/main", head]);
  const observed: SetupRun[] = [];
  const service: AutomaticSetup = new AutomaticSetup({ git, repo: { ...f.ctx.repo, mirrorDir: directory }, jobs: f.ctx.jobs,
    capabilities: async () => [], activate: async () => {}, now: () => new Date(at),
    onAssessed: async (run) => {
      const persisted = await service.current();
      expect(persisted).toEqual(run);
      expect(persisted!.artifacts.some(artifact => artifact.path === "ephyra/bootstrap.json")).toBe(true);
      observed.push(structuredClone(run));
      run.bootstrap!.requests[0]!.question = "A hook cannot replace the saved request.";
      if (observed.length === 1) throw new Error("The queue is temporarily unavailable.");
    },
  });
  await service.start("supervised", "bootstrap-contact-hook-initial");
  expect(observed).toHaveLength(0);
  const job = f.ctx.queued.find(item => item.kind === "automatic_setup")!;
  await f.ctx.jobRunners.get(job.kind)!(job.payload, { key: job.key, attempt: 1 });
  const initial = (await service.current())!;
  expect(initial.status).toBe("ready");
  expect(initial.bootstrap!.requests.some(request => request.status === "open")).toBe(true);
  expect(observed).toHaveLength(1);
  const question = initial.bootstrap!.requests.find(request => request.kind === "context")!;
  await service.respond({ setupId: initial.id, head, requestId: question.id, text: "Account access must retain existing data." },
    { id: did, kind: "human" }, "bootstrap-contact-hook-answer");
  await service.report({ setupId: initial.id, head, summary: "Repository context remains unverified." },
    { id: "agent-fixture", kind: "agent" }, "bootstrap-contact-hook-report");
  await service.reassess();
  await service.restore();
  expect(observed).toHaveLength(5);
  expect(observed[1]!.bootstrap!.requests.find(request => request.id === question.id)!.answer?.text)
    .toBe("Account access must retain existing data.");
  expect(observed[2]!.bootstrap!.contextReports).toHaveLength(1);
  expect((await service.current())!.bootstrap!.requests[0]!.question).not.toBe("A hook cannot replace the saved request.");
});
