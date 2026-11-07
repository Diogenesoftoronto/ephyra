// The shipped console client against the composed server, using in-process HTTP and a fake model. No network.
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTONOMY_TEMPLATE } from "../packages/policy/src/index.ts";
import { ConsoleClient } from "../apps/console/src/api.ts";
import { compose } from "../apps/server/src/compose.ts";
import { readConfig } from "../apps/server/src/config.ts";
import { FakeDraftModel } from "../apps/server/src/velum.ts";
import type { SpeechProvider } from "../apps/server/src/voice-provider.ts";
import { Trail, TrailEvent, trailTutorBinding } from "../packages/core/src/index.ts";
import { TUTOR_MODEL } from "../apps/server/src/humans.ts";

test("console client reads usage, edits the map, applies a proposal and publishes a git policy ref", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ephyra-console-contract-"));
  await writeFile(join(dir, "autonomy.md"), AUTONOMY_TEMPLATE);
  const token = "fixture-" + "t".repeat(32);
  const proposed = AUTONOMY_TEMPLATE.replace("risk: medium", "risk: high");
  const model = new FakeDraftModel(() => JSON.stringify({ text: "Cart needs closer review.",
    proposal: { content: proposed, summary: "Cart becomes high risk" } }));
  const server = await compose(readConfig({ EPHYRA_API_TOKEN: token, EPHYRA_DATA_DIR: join(dir, "data"),
    EPHYRA_AUTONOMY_FILE: join(dir, "autonomy.md"), EPHYRA_DRAFT: "fake" }), { startJobs: false, draftModel: model });
  try {
    const client = new ConsoleClient("http://fixture.test", token,
      (async (url: RequestInfo | URL, init?: RequestInit) => server.app.request(String(url), init)) as typeof fetch, "test-operator");
    expect(await client.identity()).toMatchObject({ principal: "test-operator", kind: "service", approver: true });
    const docs = await client.docs();
    expect(docs.some((d) => d.path === "autonomy.md")).toBe(true);
    expect((await client.usage()).totals.unknownCost).toBe(0);
    const draft = await client.createDraft("autonomy.md", "create-0001");
    expect(draft.sketches?.length).toBeGreaterThan(0);
    const changed = await client.updateSketches(draft.id, draft.sketches!.map((s) => ({ ...s, intent: "Human-written intent." })),
      draft.baseDigest, "map-0001");
    expect(changed.content).toContain("Human-written intent.");
    const response = await client.sendMessage(draft.id, "Make the cart high risk", "chat-0001");
    const proposal = response.messages.findLast((m) => m.proposal)!;
    expect(proposal).toBeDefined();
    const applied = await client.applyProposal(draft.id, proposal.id, "apply-0001");
    expect(applied.content).toContain("risk: high");
    const published = await client.publish(draft.id, "publish-0001");
    expect(published.published?.ref).toBe(`refs/ephyra/policy/${draft.id}`);
    expect(published.published?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await client.doc("autonomy.md")).content).toBe(AUTONOMY_TEMPLATE);
    expect((await client.entries({ persona: "velum" })).entries[0]?.engine).toBe("fake/velum-1");
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("console voice client reaches composed speech, context and usage routes without external providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ephyra-voice-contract-"));
  const token = "fixture-" + "v".repeat(32);
  const calls: string[] = [];
  const speech: SpeechProvider = {
    kind: "compatible", billedTo: "local", transcriptionModel: "fixture-stt", speechModel: "fixture-tts", voice: "fixture", maxCostMicrousd: null,
    transcribe: async () => { calls.push("transcribe"); return { text: "What needs attention?", engine: "actual-fixture-stt", tokens: null, costMicrousd: null }; },
    speak: async () => { calls.push("speak"); return { audio: "AQIDBA==", mime: "audio/mpeg", engine: null, tokens: null, costMicrousd: null }; },
  };
  const model = new FakeDraftModel(() => "There are no recorded trails in this fixture.");
  const server = await compose(readConfig({ EPHYRA_API_TOKEN: token, EPHYRA_DATA_DIR: join(dir, "data"), EPHYRA_DRAFT: "fake" }),
    { startJobs: false, draftModel: model, speechProvider: speech });
  try {
    const client = new ConsoleClient("http://fixture.test", token,
      (async (url: RequestInfo | URL, init?: RequestInit) => server.app.request(String(url), init)) as typeof fetch, "voice-operator");
    expect(await client.voiceCapabilities()).toMatchObject({ provider: "compatible", transcriptionModel: "fixture-stt", conversation: true });
    const signal = new AbortController().signal;
    const transcript = await client.transcribe({ audio: "AQIDBA==", mime: "audio/webm" }, "voice-input-001", signal);
    const reply = await client.voiceReply({ context: { kind: "overview" }, messages: [{ role: "user", text: transcript.text }] }, "voice-reply-001", signal);
    expect(reply.text).toBe("There are no recorded trails in this fixture.");
    expect(model.calls[0]!.messages[0]!.content).toContain('"inbox":[]');
    const clip = await client.speak(reply.text, "voice-speak-001", signal);
    expect(clip.receipt.engine).toBeNull(); expect(clip.receipt.costMicrousd).toBeNull();
    expect(await client.speak(reply.text, "voice-speak-001", signal)).toEqual(clip);
    expect(calls).toEqual(["transcribe", "speak"]);
    const entries = await client.entries({ persona: "velum" });
    expect(entries.entries.map(e => e.step).sort()).toEqual(["voice.reply", "voice.speak", "voice.transcribe"]);
    expect((await client.usage()).totals.unknownCost).toBe(2);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("console Tutor client reads grounded explanations and metered usage from the composed server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ephyra-tutor-contract-"));
  const token = "fixture-" + "t".repeat(32), id = "11111111-1111-4111-8111-111111111111", now = new Date().toISOString();
  let calls = 0;
  const server = await compose(readConfig({ EPHYRA_API_TOKEN: token, EPHYRA_DATA_DIR: dir }), { startJobs: false,
    tutorBackend: { kind: "notorganic", billedTo: "notorganic", maxCostMicrousd: 100000, consult: async (_question, context) => {
      calls++; expect(context).toContain("No proof for this revision");
      return { text: "No reproduction or proof is recorded yet. What behavior do you want to establish?", engine: TUTOR_MODEL, tokens: 51, costMicrousd: null };
    } } });
  try {
    const trail = Trail.parse({ schema: 1, id, short: "T-contract", repo: "default", title: "Checkout", rev: 1, state: "researching", signals: [id], area: "checkout", risk: "high", route: "auto_fix", severity: 2,
      base: { ref: "main", sha: "a".repeat(40) }, checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
      budget: { tokensUsed: 0, tokensMax: 1000, wallclockMaxS: 100, spendMicrousdUsed: 0, spendMicrousdMax: 100000 }, createdAt: now, updatedAt: now });
    const initial = TrailEvent.parse({ schema: 1, id, trail: id, rev: 1, at: now, actor: { kind: "system", id: "fixture" }, type: "trail_created",
      data: { signalId: id, title: trail.title, baseRef: trail.base.ref, baseSha: trail.base.sha } });
    await server.ctx.start(trail, initial);
    const client = new ConsoleClient("http://fixture.test", token,
      (async (url: RequestInfo | URL, init?: RequestInit) => server.app.request(String(url), init)) as typeof fetch, "tutor-operator");
    expect((await client.tutorCapabilities()).model).toBe(TUTOR_MODEL);
    const current = await client.trail(id), signal = new AbortController().signal;
    const input = { trailId: id, bound: trailTutorBinding(current.trail, current.events), question: "Explain the evidence", history: [] };
    const reply = await client.explainTrail(input, "tutor-contract-01", signal);
    expect(reply.receipt.engine).toBe(TUTOR_MODEL);
    expect(await client.explainTrail(input, "tutor-contract-01", signal)).toEqual(reply); expect(calls).toBe(1);
    expect((await client.entries({ trail: id })).entries[0]).toMatchObject({ kind: "study", step: "tutor.explain", costMicrousd: null, tokens: 51 });
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
