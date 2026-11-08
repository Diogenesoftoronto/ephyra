import { expect, test } from "bun:test";
import { ReconciliationRequired, Trail, TrailEvent, type Journal, type Runner } from "@ephyra/core";
import { MemorySignalStore } from "@ephyra/ingest";
import { AUTONOMY_TEMPLATE, THRESHOLDS_TEMPLATE, parseAutonomy, parseThresholds } from "@ephyra/policy";
import { FakeContext } from "./context.ts";
import { agentHandlers } from "./agents.ts";

test("an uncertain proof allocation parks with its operation receipt instead of triggering a job retry", async () => {
  const id = "00000000-0000-4000-8000-000000000001", sha = "a".repeat(40), now = new Date().toISOString();
  const trail = Trail.parse({ schema: 1, id, short: "T-000001", repo: "test", title: "Observed defect", rev: 2, state: "proving",
    signals: [], area: "application", risk: "medium", route: "auto_fix", severity: 1,
    base: { ref: "main", sha }, head: "b".repeat(40), checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
    budget: { tokensUsed: 0, tokensMax: 100, wallclockMaxS: 300, spendMicrousdUsed: 0, spendMicrousdMax: 0 },
    mirrors: {}, createdAt: now, updatedAt: now });
  const journal = { readFile: async () => new TextEncoder().encode("exit 1") } as unknown as Journal;
  const ctx = new FakeContext({ id: "test", url: "fixture", mirrorDir: "/unused", baseRef: "main", forge: "plain", remote: "origin" },
    { autonomy: parseAutonomy(AUTONOMY_TEMPLATE), thresholds: parseThresholds(THRESHOLDS_TEMPLATE) }, journal, new MemorySignalStore());
  ctx.put(trail);
  ctx.trails.events = async () => [TrailEvent.parse({ schema: 1, id: crypto.randomUUID(), trail: id, rev: 1, at: now,
    actor: { kind: "agent", id: "fixture" }, type: "repro_completed", data: { ok: true, probe: ".ephyra/repro/probe.sh" } })];
  let allocated = 0;
  const runner = { name: "fixture", allocate: async () => {
    allocated++; throw new ReconciliationRequired("provider-create-key", "Uncertain allocation outcome");
  } } as unknown as Runner;
  agentHandlers(ctx, { runner, agent: null, stepTimeoutS: 60,
    profile: { name: "fixture", digest: "fixture", network: "egress", readOnlyProd: true, credentials: [],
      limits: { cpu: 1, memoryMb: 1000, diskMb: 0, timeoutS: 60 } }, buildProof: async () => { throw new Error("must not run proof"); } });
  await ctx.jobRunners.get("proof")!({ trailId: id, rev: 2, operationKey: "proof-fixture" }, { key: "proof-fixture", attempt: 1 });
  expect(allocated).toBe(1);
  expect(ctx.emitted).toHaveLength(1);
  expect(ctx.emitted[0]).toMatchObject({ type: "agent_failed", data: { step: "proof", retryable: false } });
  expect(JSON.parse(String(ctx.emitted[0]!.files!["proof/error.json"]))).toMatchObject({
    operationKey: "proof-fixture", reconciliationRequired: true,
  });
});
