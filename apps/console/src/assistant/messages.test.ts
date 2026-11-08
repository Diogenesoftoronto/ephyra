import { describe, expect, test } from "bun:test";
import type { AgentRunEvent } from "@ephyra/core";
import { FakeApi } from "../fake/api.ts";
import { RUN_IDS } from "../fake/runs.ts";
import { formMessage } from "../lib/protocol.ts";
import { displayHumanText, draftToThread, eventsToThread, type ToolArtifact } from "./messages.ts";

const parts = (m: { content: unknown }) => m.content as Array<{ type: string; [k: string]: unknown }>;

describe("run transcript", () => {
  test("results and policy decisions join their tool call; status and portal stay in order", async () => {
    const api = new FakeApi();
    const run = await api.run(RUN_IDS.orb);
    const [message] = eventsToThread(await api.runEvents(RUN_IDS.orb), run);
    const ps = parts(message!);
    const types = ps.map((p) => p.type);
    expect(types[0]).toBe("data-status");
    expect(types.slice(-2)).toEqual(["data-portal", "text"]);
    expect(ps.at(-1)).toMatchObject({ type: "text", text: "Fictional demo: an interactive explanation of the rounding change." });
    expect(types).toContain("reasoning");
    const push = ps.find((p) => p.toolCallId === "c3")!;
    expect(push.isError).toBe(true);
    expect((push.artifact as ToolArtifact).policy[0]).toMatchObject({
      decision: "reject",
      rule: "protected-ref",
    });
    const edit = ps.find((p) => p.toolCallId === "c2")!;
    expect(edit.result).toBe("Edited 9 lines.");
    expect(ps.filter((p) => p.type === "tool-call")).toHaveLength(4);
    expect(message!.status).toEqual({ type: "running" });
  });
  test("a policy decision with no matching call stands alone, and a call with no result stays pending", () => {
    const base = { runId: "r", at: "2026-11-07T15:00:00.000Z" };
    const events: AgentRunEvent[] = [
      {
        ...base,
        seq: 0,
        type: "policy",
        tool: { callId: "zz", name: "bash" },
        policy: { decision: "reject", rule: "net", reason: "no network" },
      },
      { ...base, seq: 1, type: "tool_call", tool: { callId: "a", name: "bash", args: "{not json" } },
    ];
    const ps = parts(eventsToThread(events, { status: "done", startedAt: base.at })[0]!);
    expect(ps[0]!.type).toBe("data-policy");
    expect(ps[1]).toMatchObject({ type: "tool-call", args: {} });
    expect(ps[1]!.result).toBeUndefined();
  });
  test("events are ordered by seq, and no events means no message", () => {
    expect(eventsToThread([], { status: "running", startedAt: "2026-11-07T15:00:00.000Z" })).toEqual([]);
    const at = "2026-11-07T15:00:00.000Z";
    const out = eventsToThread(
      [
        { runId: "r", at, seq: 2, type: "message", text: "second" },
        { runId: "r", at, seq: 1, type: "message", text: "first" },
      ],
      { status: "done", startedAt: at },
    );
    expect(parts(out[0]!).map((p) => p.text)).toEqual(["first", "second"]);
  });
});

describe("Velum thread", () => {
  test("maps roles and carries the form and the proposal as message parts", async () => {
    const api = new FakeApi({ seedConversation: false });
    const d = await api.createDraft("autonomy.md", "d");
    const after = await api.sendMessage(d.id, "Add an area for billing", "m");
    const thread = draftToThread(after.messages, "and one more thing");
    expect(thread.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const kinds = parts(thread[1]!).map((p) => p.type);
    expect(kinds).toEqual(["text", "data-form", "data-proposal"]);
    expect(thread[2]!.metadata?.custom).toEqual({ pending: true });
  });
  test("console-sent form and map messages are summarised instead of dumped", () => {
    expect(displayHumanText(formMessage({ values: { "/area/name": "billing" } }))).toBe(
      "Applied the form (1 value).",
    );
    expect(displayHumanText("Apply these form values:\n{broken")).toBe("Applied the form.");
    expect(displayHumanText("hello")).toBe("hello");
  });
});
