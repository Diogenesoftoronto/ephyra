import { test, expect } from "bun:test";
import { ensureDataset, experimentRows, sendTraces, tracePayload, ax, type Ax } from "../src/arize";
import { loadCorpus, corpusHash, APP } from "../src/data";
import { Telemetry } from "../src/telemetry";
import { mkdir, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import type { CaseResult } from "../src/results";
test("Fake AX maps stable cases and never creates on a failed read", async () => {
  const rows = (await loadCorpus("triage")).slice(0, 2);
  let created = 0;
  const fake: Ax = async (args, stdin) => {
    if (args[1] === "list") return "[]";
    if (args[1] === "create") {
      created++;
      expect(JSON.parse(stdin!)[0].case_id).toBe(rows[0]!.case_id);
      return '{"id":"dataset"}';
    }
    return JSON.stringify(
      rows.map((r, i) => ({
        id: "example" + i,
        additional_properties: { case_id: r.case_id, input: JSON.stringify(r.input, Object.keys(r.input)) },
      })),
    );
  };
  // Use only canonical checked fields in the real export response.
  const good: Ax = async (args, stdin) =>
    args[1] === "export"
      ? JSON.stringify(rows.map((r, i) => ({ id: "e" + i, additional_properties: { case_id: r.case_id } })))
      : fake(args, stdin);
  const d = await ensureDataset(rows, good);
  expect(d.name).toBe("ephyra-triage-" + corpusHash(rows));
  expect(d.examples.size).toBe(2);
  expect(created).toBe(1);
  await expect(
    ensureDataset(rows, async () => {
      throw new Error("read failed");
    }),
  ).rejects.toThrow("read failed");
  expect(created).toBe(1);
  await expect(
    ensureDataset(rows, async (args) =>
      args[1] === "list" ? '[{"name":"' + d.name + '","id":"dataset"}]' : "[]",
    ),
  ).rejects.toThrow("incomplete");
});
test("Missing scores upload as labels, never fake zeros", () => {
  const base: CaseResult = {
    case_id: "a",
    identity: "x",
    status: "scored",
    scores: { q: { score: 1, label: "pass", explanation: "observed" } },
    output: {},
    wallMs: 1,
    tokens: null,
    costMicrousd: null,
    traceId: "t",
  };
  const rows = experimentRows(
    [
      base,
      {
        ...base,
        case_id: "b",
        status: "unavailable",
        reason: "authentication",
        scores: { q: { score: null, label: "unavailable", explanation: "auth" } },
      },
    ],
    new Map([
      ["a", "1"],
      ["b", "2"],
    ]),
  );
  expect(rows.labelOnly).toEqual(["q"]);
  expect(rows.rows[0]!["eval.q.score"]).toBeUndefined();
  expect(rows.rows[0]!["eval.q.explanation"]).toContain("score=1");
  expect(rows.rows[1]!["eval.q.label"]).toBe("unavailable");
});
test("OTLP contains real CHAIN parentage, nested LLM/AGENT/TOOL, and redacts credentials; fake endpoint only", async () => {
  const t = new Telemetry();
  await t.span("CHAIN", "case", {}, undefined, async (parent) => {
    await t.span("LLM", "model", { text: "token=canary-secret" }, parent, async (s) => {
      s.setAttribute("llm.model_name", "exact/backend");
    });
    await t.span("AGENT", "agent", {}, parent, async (s) => {
      await t.span("TOOL", "git", {}, s, async () => {});
    });
  });
  await t.provider.forceFlush();
  const spans = t.memory.getFinishedSpans();
  expect(spans.length).toBe(4);
  const parent = spans.find((s) => s.name === "case")!;
  expect(spans.find((s) => s.name === "model")!.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain("canary-secret");
  let calls = 0;
  const fake = (async (_url, req) => {
    calls++;
    expect(new Headers(req?.headers).get("Content-Type")).toBe("application/x-protobuf");
    expect(Buffer.from(req!.body as any).length).toBeGreaterThan(10);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  expect(
    (
      await sendTraces(tracePayload(spans), {
        endpoint: "https://fake.invalid/v1/traces",
        apiKey: "fake",
        spaceId: "fake",
        key: "operation",
        fetch: fake,
      })
    ).accepted,
  ).toBe(true);
  expect(calls).toBe(1);
  await expect(
    sendTraces(tracePayload(spans), {
      endpoint: "https://fake.invalid",
      apiKey: "fake",
      spaceId: "fake",
      key: "ambiguous",
      fetch: (async () => {
        throw new Error("lost");
      }) as unknown as typeof fetch,
    }),
  ).rejects.toThrow("outcome unknown");
  await t.provider.shutdown();
});
test("Real subprocess transport with fake ax consumes stdin literally", async () => {
  await mkdir(APP + ".work", { recursive: true });
  const dir = await mkdtemp(APP + ".work/fake-ax-");
  const before = process.env.EPHYRA_AX_BIN;
  try {
    const file = dir + "/ax";
    await writeFile(
      file,
      "#!/usr/bin/env bun\nconst text=await Bun.stdin.text();console.log(JSON.stringify({args:Bun.argv.slice(2),text}));\n",
    );
    await chmod(file, 0o755);
    process.env.EPHYRA_AX_BIN = file;
    const result = JSON.parse(await ax(["datasets", "create"], "literal $(must-not-execute)"));
    expect(result.text).toBe("literal $(must-not-execute)");
    expect(result.args).toEqual(["datasets", "create"]);
  } finally {
    if (before === undefined) delete process.env.EPHYRA_AX_BIN;
    else process.env.EPHYRA_AX_BIN = before;
    await rm(dir, { recursive: true, force: true });
  }
});
