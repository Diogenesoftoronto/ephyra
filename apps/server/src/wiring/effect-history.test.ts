// The effect history is what a reader of a trail sees under the hood: every effect a transition asked for, in order, with
// the event that caused it. These tests run the real engine over a real Git journal.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fc from "fast-check";
import { Trail, TrailEvent, Unverified, type Effect, type TransitionContext } from "@ephyra/core";
import { GitJournal } from "@ephyra/journal";
import type { EffectHandlers } from "../orchestrator.ts";
import { KnowledgeOperationLedger } from "../setup/knowledge-ledger.ts";
import { Engine } from "./runtime.ts";
import { MemoryStore } from "./store.ts";
import {
  EFFECT_HISTORY_PATH, EFFECT_OUTBOX_PATH, effectHistory, readEffectHistory, readEffectOutbox, recordEffects, type RecordedEffect,
} from "./effect-outbox.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const id = "019cc100-0000-7000-8000-000000000002";
const at = "2026-11-10T10:00:00.000Z";
const context: TransitionContext = { now: at, blocking: { A: true, B: true, C: true }, landingModes: ["trail_ref"] };
const trail = () => Trail.parse({ schema: 1, id, short: "T-000002", repo: "fixture", title: "Effect history", rev: 1,
  state: "researching", signals: [id], area: "application", risk: "low", route: "auto_fix", severity: 1,
  base: { ref: "refs/heads/main", sha: "a".repeat(40) }, checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
  budget: { tokensUsed: 0, tokensMax: 1000, wallclockMaxS: 600, spendMicrousdUsed: 0, spendMicrousdMax: 100 },
  mirrors: {}, createdAt: at, updatedAt: at });
const first = () => TrailEvent.parse({ schema: 1, id: crypto.randomUUID(), trail: id, rev: 1, at,
  actor: { kind: "system", id: "fixture" }, type: "trail_created", data: {
    signalId: id, title: "Effect history", baseRef: "refs/heads/main", baseSha: "a".repeat(40),
  } });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-effect-history-"));
  directories.push(directory);
  const gitDir = join(directory, "journal.git");
  expect(await Bun.spawn(["git", "init", "--bare", "-q", gitDir], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
  const journal = new GitJournal({ gitDir, clock: { now: () => new Date(at) } });
  const logs: string[] = [];
  const engine = new Engine(new MemoryStore(), journal, new KnowledgeOperationLedger(join(directory, "operations")),
    async () => context, { uuidv7: () => crypto.randomUUID() }, message => { logs.push(message); });
  const delivered: Effect[] = [];
  engine.setHandlers(new Proxy({}, { get: () => async (effect: Effect) => { delivered.push(effect); } }) as EffectHandlers);
  return { engine, journal, logs, delivered, initial: first() };
}

const effectOf = (key: string): Effect => ({ type: "start_agent", key, step: "research" });
const keys = fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 40 });

test("recorded effects keep their order, hold one entry per operation key and never exceed the cap", () => {
  fc.assert(fc.property(fc.array(keys, { maxLength: 30 }), batches => {
    let history: RecordedEffect[] = [];
    const seen: string[] = [];
    batches.forEach((batch, index) => {
      history = recordEffects(history, `event-${index}`, batch.map(effectOf));
      for (const key of batch) if (!seen.includes(key)) seen.push(key);
    });
    expect(history.map(entry => entry.effect.key)).toEqual(seen.slice(-500));
    expect(new Set(history.map(entry => entry.effect.key)).size).toBe(history.length);
    // Recording the same batch again changes nothing: the first cause stays.
    const last = batches.at(-1) ?? [];
    expect(effectHistory(recordEffects(history, "a later replay", last.map(effectOf)))).toBe(effectHistory(history));
  }), { numRuns: 100 });
});

test("the cap drops the oldest effects first", () => {
  const many = Array.from({ length: 520 }, (_, index) => effectOf(`key-${index}`));
  const history = recordEffects([], "event", many);
  expect(history).toHaveLength(500);
  expect(history[0]!.effect.key).toBe("key-20");
  expect(history.at(-1)!.effect.key).toBe("key-519");
});

test("the engine journals each transition's effects with their cause, and the history outlives delivery", async () => {
  const f = await fixture();
  const start = effectOf("history-research");
  await f.engine.start(trail(), f.initial, [start]);
  await f.engine.emit({ trail: id, actor: { kind: "agent", id: "fixture" }, type: "research_completed",
    data: { hypothesis: "hypothesis.md" } });
  const completed = (await f.journal.read(id))!.events.find(event => event.type === "research_completed")!.id;
  const comment = { trail: id, actor: { kind: "human" as const, id: "owner" }, eventId: crypto.randomUUID(),
    type: "human_comment" as const, data: { text: "Noted", isRequest: false } };
  await f.engine.emit(comment);
  const history = await readEffectHistory(f.journal, id);
  expect(history.map(entry => entry.effect.type)).toEqual(["start_agent", "request_checkpoint", "reply_comment"]);
  expect(history[0]).toEqual({ cause: f.initial.id, effect: start });
  expect(history.map(entry => entry.cause)).toEqual([f.initial.id, completed, comment.eventId]);
  // The outbox holds what is still owed and is pruned as work is superseded. The history keeps everything asked for.
  expect(f.delivered.map(effect => effect.key)).toEqual(history.map(entry => entry.effect.key));
  const owed = (await readEffectOutbox(f.journal, id)).map(entry => entry.effect.key);
  expect(history.map(entry => entry.effect.key)).toEqual(expect.arrayContaining(owed));
  // The same request delivered again records nothing twice.
  await f.engine.emit(comment);
  expect(await readEffectHistory(f.journal, id)).toEqual(history);
});

test("an event with no effects leaves the history file as it was", async () => {
  const f = await fixture();
  await f.engine.start(trail(), f.initial, [effectOf("history-quiet")]);
  const before = await f.journal.readFile(id, EFFECT_HISTORY_PATH);
  await f.engine.emit({ trail: id, actor: { kind: "system", id: "usage" }, type: "usage_recorded",
    data: { operationKey: "quiet-turn", tokens: 5, costMicrousd: 0, wallMs: 1 } });
  expect((await f.journal.read(id))!.trail.budget.tokensUsed).toBe(5);
  expect(await f.journal.readFile(id, EFFECT_HISTORY_PATH)).toEqual(before);
});

test("a trail journaled before the history existed reads as empty, and a corrupt history is refused", async () => {
  const f = await fixture();
  await f.engine.start(trail(), f.initial);
  expect(await readEffectHistory(f.journal, id)).toEqual([]);
  const current = (await f.journal.read(id))!;
  await f.journal.append(id, current.head, current.trail, [], { [EFFECT_HISTORY_PATH]: "{broken" });
  await expect(readEffectHistory(f.journal, id)).rejects.toThrow(Unverified);
  // The transition still commits. The unreadable history is left alone, never rebuilt from events.
  await f.engine.emit({ trail: id, actor: { kind: "agent", id: "fixture" }, type: "research_completed",
    data: { hypothesis: "hypothesis.md" } });
  expect((await f.journal.read(id))!.trail.state).toBe("hypothesised");
  expect(f.logs).toContain("effect history left unchanged");
  expect(new TextDecoder().decode((await f.journal.readFile(id, EFFECT_HISTORY_PATH))!)).toBe("{broken");
});

test("attach writes files beside the trail without an event, a revision or an effect", async () => {
  const f = await fixture();
  await f.engine.start(trail(), f.initial);
  const before = (await f.journal.read(id))!;
  expect(await f.engine.attach(id, { "artefacts/recovery/research-1-1.json": "{\"attempt\":1}" },
    { rev: 1, state: "researching" })).toBe(true);
  const after = (await f.journal.read(id))!;
  expect(after.head).not.toBe(before.head);
  expect(after.trail).toEqual(before.trail);
  expect(after.events).toEqual(before.events);
  expect(new TextDecoder().decode((await f.journal.readFile(id, "artefacts/recovery/research-1-1.json"))!)).toBe("{\"attempt\":1}");
  expect(f.delivered).toHaveLength(0);
});

test("attach refuses work that has moved on, an unknown trail and the reserved outbox", async () => {
  const f = await fixture();
  await f.engine.start(trail(), f.initial);
  const files = { "artefacts/recovery/research-1-1.json": "{}" };
  const head = (await f.journal.read(id))!.head;
  expect(await f.engine.attach(id, files, { rev: 2, state: "researching" })).toBe(false);
  expect(await f.engine.attach(id, files, { rev: 1, state: "patching" })).toBe(false);
  expect(await f.engine.attach(id, files, { rev: 1, state: "researching", generation: 3 })).toBe(false);
  expect(await f.engine.attach("019cc100-0000-7000-8000-00000000ffff", files)).toBe(false);
  expect((await f.journal.read(id))!.head).toBe(head);
  await expect(f.engine.attach(id, { [EFFECT_OUTBOX_PATH]: "[]" })).rejects.toThrow("reserved");
  await expect(f.engine.attach(id, { [EFFECT_HISTORY_PATH]: "[]" })).rejects.toThrow("reserved");
  expect((await f.journal.read(id))!.head).toBe(head);
});
