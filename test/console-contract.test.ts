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
