// Question routes on a self-hosted server, over the real question service and a real Git journal. The decide backend and
// the drafting model are fixtures under their own identities; nothing here reaches a network.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Trail, type InvestigationContact, type InvestigationQuestion, type JudgementResponse, type PeopleConnection } from "@ephyra/core";
import { GitJournal } from "@ephyra/journal";
import { MemorySignalStore } from "@ephyra/ingest";
import { DEFAULT_THRESHOLDS, parseAutonomy } from "@ephyra/policy";
import { SecretBox } from "../auth/crypto.ts";
import { MemoryOperationLedger } from "../orchestrator/effects.ts";
import { InvestigationQuestions } from "../setup/questions.ts";
import { FakeContext } from "../wiring/context.ts";
import { createApp, type HttpPort } from "./app.ts";
import { questionRoutes } from "./questions.ts";

const TOKEN = "fixture-service-token";
const MAINTAINER = "did:key:fixture-maintainer";
const WORKSPACE = "self-hosted";
const MODEL = "fixture/decide-1";
const NOW = "2026-11-10T12:00:00.000Z";
const REASON = "The expected rounding for a split shipment is not written down anywhere";
const ANSWER = "Split shipments round each parcel up to the next whole cent.";
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

const contact: InvestigationContact = { id: "maintainer", alias: "Fixture maintainer", roles: ["maintainer"], areas: [], did: MAINTAINER };
const verdict = (choice: "accept" | "reject"): JudgementResponse => ({ model: MODEL, answers: { verdict: { type: "choice", choice,
  confidence: 0.96, probabilities: choice === "accept" ? { accept: 0.96, reject: 0.04 } : { accept: 0.04, reject: 0.96 } } } });

async function fixture(extra: { contacts?: InvestigationContact[]; answerVerdict?: "accept" | "reject" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ephyra-question-routes-")); dirs.push(dir);
  expect(await Bun.spawn(["git", "init", "--bare", "-q", dir], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
  const journal = new GitJournal({ gitDir: dir, clock: { now: () => new Date(NOW) } });
  const ctx = new FakeContext({ id: WORKSPACE, url: dir, mirrorDir: dir, baseRef: "main", forge: "plain", remote: "origin" },
    { autonomy: parseAutonomy("## defaults\nmode: enforce\ncheckpoints: A=advisory B=advisory C=advisory\nlanding: trail_ref\n"),
      thresholds: { [MODEL]: { ...DEFAULT_THRESHOLDS, confidence: 0.8 } } }, journal, new MemorySignalStore(), { now: () => new Date(NOW) });
  const trail = Trail.parse({ schema: 1, id: crypto.randomUUID(), short: "T-fixture", repo: WORKSPACE, title: "Split shipment totals drift",
    rev: 1, state: "parked", resumeTo: "reproducing", signals: [crypto.randomUUID()], area: "shipping", risk: "low", route: "auto_fix",
    severity: 2, base: { ref: "main", sha: "a".repeat(40) }, checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
    budget: { tokensUsed: 0, tokensMax: 10000, wallclockMaxS: 500, spendMicrousdUsed: 0, spendMicrousdMax: 10000 },
    createdAt: NOW, updatedAt: NOW });
  await journal.create(trail, { schema: 1, id: crypto.randomUUID(), trail: trail.id, rev: 1, at: NOW,
    actor: { kind: "system", id: "test" }, type: "trail_created",
    data: { signalId: trail.signals[0]!, title: trail.title, baseRef: "main", baseSha: trail.base.sha } });
  ctx.put(trail);
  ctx.emit = async (input) => {
    const current = (await journal.read(input.trail))!;
    if (input.type !== "resumed" || current.trail.state !== "parked") throw new Error("Unexpected event");
    ctx.emitted.push(input);
    const resumed = { ...current.trail, state: "reproducing" as const };
    await journal.append(trail.id, current.head, resumed, [{ schema: 1, id: crypto.randomUUID(), trail: trail.id, rev: resumed.rev,
      at: NOW, actor: input.actor, type: "resumed", data: {} }]);
    ctx.put(resumed);
  };
  const settings: PeopleConnection = { enabled: true, workspaceId: WORKSPACE, contacts: extra.contacts ?? [contact],
    webhookUrl: null, keyConfigured: false, updatedAt: NOW };
  const phases: string[] = [];
  const questions = new InvestigationQuestions({ ctx, did: MAINTAINER, workspaceId: WORKSPACE, ledger: new MemoryOperationLedger(),
    box: await SecretBox.fromBase64(Buffer.alloc(32, 9).toString("base64")), publicOrigin: "http://localhost:4317", timeoutMs: 1500,
    connection: async () => ({ settings: structuredClone(settings) }),
    model: async () => ({ kind: "fake", billedTo: "byok", complete: async () => ({
      text: JSON.stringify({ recipient: settings.contacts[0]!.id, question: "How are split shipment totals rounded?",
        reason: "The reproduction needs the expected total.", acceptance: "State the rounding rule for split shipments." }),
      engine: "fixture/draft-1", tokens: null, costMicrousd: null }) }),
    decide: { kind: "notorganic", alias: "fixture", supports: ["choice"], decide: async () => {
      phases.push(phases.length === 0 ? "question" : "answer");
      return verdict(phases.length === 1 ? "accept" : extra.answerVerdict ?? "accept");
    } },
    fetcher: async () => { throw new Error("no network in tests"); } });
  const port = {} as HttpPort;
  const app = createApp(TOKEN, port, new Hono(), undefined, undefined, () => questionRoutes(questions));
  const headers = (principal: string) => ({ Authorization: `Bearer ${TOKEN}`, "X-Ephyra-Principal": principal,
    "Content-Type": "application/json" });
  const answer = (q: InvestigationQuestion, principal: string, body: unknown = { text: ANSWER }) =>
    app.request(`/v1/questions/${q.trailId}/${q.id}/answer`, { method: "POST", headers: headers(principal), body: JSON.stringify(body) });
  const asked = (await questions.ask(trail.id, REASON, "recovery:one"))!;
  return { app, ctx, journal, trail, questions, asked, headers, answer, phases };
}

describe("question routes on a self-hosted server", () => {
  test("any authenticated principal can read what a quest is asking, and nobody else can", async () => {
    const f = await fixture();
    expect(f.asked).toMatchObject({ status: "awaiting_answer", recipient: { id: "maintainer", did: MAINTAINER },
      delivery: { kind: "inbox", status: "sent" } });
    const list = await f.app.request("/v1/questions", { headers: f.headers("operator") });
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    expect(await list.json()).toEqual([f.asked]);
    const one = await f.app.request(`/v1/questions/${f.trail.id}/${f.asked.id}`, { headers: f.headers("operator") });
    expect(await one.json()).toEqual(f.asked);
    const missing = await f.app.request(`/v1/questions/${f.trail.id}/${"0".repeat(64)}`, { headers: f.headers("operator") });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toBeNull();
    expect((await f.app.request("/v1/questions")).status).toBe(401);
    expect((await f.app.request("/v1/questions", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  test("only the principal the question was addressed to can answer it", async () => {
    const f = await fixture();
    const refused = await f.answer(f.asked, "operator");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "This question is for another recipient." });
    // The refused answer never reached the check, changed the question or resumed the quest.
    expect(f.phases).toEqual(["question"]);
    expect(await f.questions.get(f.trail.id, f.asked.id)).toEqual(f.asked);
    expect(f.ctx.emitted).toHaveLength(0);
    expect((await f.journal.read(f.trail.id))!.trail.state).toBe("parked");
  });

  test("a recipient with no principal of their own cannot be answered for over the API", async () => {
    const outside: InvestigationContact = { id: "product-owner", alias: "Product owner", roles: ["product"], areas: [] };
    const f = await fixture({ contacts: [outside] });
    // No bridge is configured in this fixture, so the question exists but is not one any signed principal owns.
    expect(f.asked.recipient?.did).toBeUndefined();
    for (const principal of ["operator", "product-owner", MAINTAINER]) expect((await f.answer(f.asked, principal)).status).toBe(403);
  });

  test("the recipient's answer is checked, recorded and resumes the quest exactly once", async () => {
    const f = await fixture();
    for (const body of [null, {}, { text: "" }, { text: "x".repeat(4001) }, { text: ANSWER, extra: true }]) {
      const invalid = await f.answer(f.asked, MAINTAINER, body);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "Enter a concise factual answer." });
    }
    const accepted = await f.answer(f.asked, MAINTAINER);
    expect(accepted.status).toBe(200);
    const saved = await accepted.json() as InvestigationQuestion;
    expect(saved).toMatchObject({ status: "answered", answer: { text: ANSWER, accepted: true } });
    expect(saved.checks.map((check) => [check.phase, check.model, check.accepted])).toEqual([
      ["question", MODEL, true], ["answer", MODEL, true],
    ]);
    expect(f.ctx.emitted).toHaveLength(1);
    expect(f.ctx.emitted[0]).toMatchObject({ type: "resumed", actor: { kind: "system", id: `answer:${f.asked.id}` } });
    expect((await f.journal.read(f.trail.id))!.trail.state).toBe("reproducing");
    // Sent again, the same answer returns the same record and does not resume or check a second time.
    expect((await f.answer(f.asked, MAINTAINER)).status).toBe(200);
    expect(f.ctx.emitted).toHaveLength(1);
    expect(f.phases).toEqual(["question", "answer"]);
    // A question on a quest that is working again is no longer open.
    expect(await (await f.app.request("/v1/questions", { headers: f.headers("operator") })).json()).toEqual([]);
  });

  test("an answer the check does not accept is kept as rejected and the quest stays stopped", async () => {
    const f = await fixture({ answerVerdict: "reject" });
    const response = await f.answer(f.asked, MAINTAINER);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "rejected", answer: { accepted: false } });
    expect(f.ctx.emitted).toHaveLength(0);
    expect((await f.journal.read(f.trail.id))!.trail.state).toBe("parked");
  });
});
