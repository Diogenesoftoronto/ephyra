import { expect, test } from "bun:test";
import { Signal, type DecideBackend, type ExtractBackend, type Journal } from "@ephyra/core";
import { MemorySignalStore } from "@ephyra/ingest";
import { AUTONOMY_TEMPLATE, THRESHOLDS_TEMPLATE, parseAutonomy, parseThresholds } from "@ephyra/policy";
import { FakeContext } from "./context.ts";
import { triageSignal } from "./intake.ts";

test("bootstrap can observe a real signal while unready without paying for extraction or judgement", async () => {
  const at = "2026-11-08T12:00:00.000Z";
  const ctx = new FakeContext({ id: "fixture", url: "https://git.example.org/application.git", mirrorDir: "/unused",
    baseRef: "refs/heads/main", forge: "plain", remote: "origin" },
  { autonomy: parseAutonomy(AUTONOMY_TEMPLATE), thresholds: parseThresholds(THRESHOLDS_TEMPLATE) },
  {} as Journal, new MemorySignalStore(), { now: () => new Date(at) });
  let extracts = 0, judgements = 0;
  const extract: ExtractBackend = { kind: "parser", alias: "offline-extract", extract: async () => {
    extracts++; throw new Error("must not dispatch");
  } };
  const decide: DecideBackend = { kind: "selfhosted:fixture", alias: "offline-decide", supports: ["choice"], decide: async () => {
    judgements++; throw new Error("must not dispatch");
  } };
  const signal = Signal.parse({ schema: 1, id: crypto.randomUUID(), kind: "error", repo: "fixture", environment: "unknown",
    fingerprint: "observed-fixture-error", title: "Observed fixture exception", message: "The exception was actually ingested.",
    firstSeen: at, lastSeen: at, count: 1, source: "offline-fixture" });
  await triageSignal(ctx, { extract, decide, canInvestigate: async () => false, baseSha: async () => "a".repeat(40),
    budget: { tokensUsed: 0, tokensMax: 1000, wallclockMaxS: 30, spendMicrousdUsed: 0, spendMicrousdMax: 0 } }, signal, "fixture-intake");
  expect({ extracts, judgements }).toEqual({ extracts: 0, judgements: 0 });
  expect(ctx.started).toHaveLength(1);
  expect(ctx.started[0]!.trail).toMatchObject({ signals: [signal.id], route: "human" });
  expect(ctx.started[0]!.effects.some(effect => effect.type === "start_agent")).toBe(false);
});
