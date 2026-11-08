import { expect, test } from "bun:test";
import { AgentRunEvent } from "@ephyra/core";
import { claudeStreamNormalizer, codexNormalizer, LineFeed, type RunEventDraft } from "./run-events.ts";
import { visualPublisher } from "./visuals.ts";

const visual = { id: "review", title: "Inspect the change", html: "<button onclick='this.textContent=2'>1</button>", height: 300 };
const line = `EPHYRA_VISUAL ${JSON.stringify(visual)}`;
const call = { type: "assistant", message: { content: [{ type: "tool_use", id: "c", name: "bash", input: { command: "python3 share.py" } }] } };
const result = (content: string, failed = false) => ({ type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "c", content, is_error: failed }] } });

test("Amp/Claude shell output becomes a full saved visual before ordinary log truncation", async () => {
  const full = { ...visual, html: "<p>" + "x".repeat(14000) + "</p>" };
  const stream = [call, result(`EPHYRA_VISUAL ${JSON.stringify(full)}`)].map((value) => JSON.stringify(value)).join("\n");
  const events: RunEventDraft[] = [];
  const feed = new LineFeed(claudeStreamNormalizer(), (event) => { events.push(event); });
  for (let i = 0; i < stream.length; i += 29) await feed.write(stream.slice(i, i + 29));
  await feed.finish();
  expect(events.find((event) => event.visual)?.visual).toEqual(full);
  expect(events.find((event) => event.type === "tool_result")?.tool?.result).toBe("[Shared visual: Inspect the change]");
  for (const event of events) AgentRunEvent.parse({ ...event, runId: "run", seq: 0, at: "2026-11-08T01:00:00.000Z" });
});

test("Codex publishes successful command output and assistant envelopes; failures and quoted inputs do not publish", () => {
  const normalizer = codexNormalizer();
  const item = { type: "command_execution", id: "c", command: "python3 share.py", aggregated_output: line, exit_code: 0, status: "completed" };
  expect(normalizer.push(JSON.stringify({ type: "item.completed", item })).find((e) => e.visual)?.visual).toEqual(visual);
  expect(normalizer.push(JSON.stringify({ type: "item.completed", item: { ...item, exit_code: 1 } })).some((e) => e.visual)).toBe(false);
  const message = `A presentation.\n\n\`\`\`ephyra-visual\n${JSON.stringify(visual)}\n\`\`\``;
  expect(normalizer.push(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } }))
    .find((e) => e.visual)?.visual).toEqual(visual);
  const claude = claudeStreamNormalizer();
  expect(claude.push(JSON.stringify(result(line))).some((e) => e.visual)).toBe(false);
  claude.push(JSON.stringify(call));
  expect(claude.push(JSON.stringify(result(line, true))).some((e) => e.visual)).toBe(false);
  expect(claude.push(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: message }] } }))).toEqual([]);
});

test("malformed, oversized and secret-bearing presentations cannot bypass saved limits", () => {
  const publish = visualPublisher(["credential-12345"]);
  const shared = publish(`EPHYRA_VISUAL ${JSON.stringify({ ...visual, html: "<p>credential-12345</p>" })}`, "tool");
  expect(shared.events[0]?.visual?.html).toBe("<p>[REDACTED]</p>");
  expect(JSON.stringify(shared)).not.toContain("credential-12345");
  for (const invalid of [{ ...visual, html: "x".repeat(240001) }, { ...visual, id: "credential-12345" }, { id: "x", title: "x" }]) {
    const result = publish(`EPHYRA_VISUAL ${JSON.stringify(invalid)}`, "tool");
    expect(result.events.some((event) => event.visual)).toBe(false);
    expect(result.text).toBe("[Visual unavailable]");
  }
});

test("service ensure can share multiple exact portal URLs, but credential URLs and failed commands are discarded", () => {
  const n = claudeStreamNormalizer({ secrets: ["credential-12345"] });
  n.push(JSON.stringify({ ...call, message: { content: [{ ...call.message.content[0], input: { command: "amp orb services ensure" } }] } }));
  const raw = "https://app.portal.test/ https://app.portal.test/admin https://me:pw@bad.test/ https://app.test/?token=credential-12345";
  expect(n.push(JSON.stringify(result(raw))).filter((e) => e.type === "portal").map((e) => e.portalUrl))
    .toEqual(["https://app.portal.test/", "https://app.portal.test/admin"]);
  expect(n.push(JSON.stringify(result(raw, true))).some((e) => e.type === "portal")).toBe(false);
});
