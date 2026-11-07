import { expect, test } from "bun:test";
import { ReconciliationRequired, type Journal } from "@ephyra/core";
import { personaProof, respondentProof, TrailsEvidence, VoxqClient, type VoxqExport } from "./src/index.ts";

const exported: VoxqExport = {
  survey: { id: "study" },
  provenance: { status: "recorded", run: { id: "sim", survey_id: "study", status: "completed" } },
  responses: [
    { source: "simulation", run_id: "sim" },
    { source: "human", respondent: "respondent-1", interview_status: "completed" },
    { source: "human", respondent: "respondent-1", interview_status: "completed" },
    { source: "human", respondent: "respondent-2", interview_status: "in_progress" },
  ],
};

test("trails rank shared fingerprint and files then recency and fetch the journal", async () => {
  const records: Record<string, any> = {
    old: { head: "old-sha", trail: { title: "old", updatedAt: "2025-01-01" }, events: [] },
    new: { head: "new-sha", trail: { title: "new", updatedAt: "2026-01-01" }, events: [] },
    unrelated: { head: "x", trail: { title: "other", updatedAt: "2026-01-01" }, events: [] },
  };
  const journal = { list: async () => Object.keys(records), read: async (id: string) => records[id] ?? null } as Journal;
  const source = new TrailsEvidence(journal, async id => id === "unrelated"
    ? { files: [], fingerprints: [] } : { files: ["a.ts"], fingerprints: ["fp"] });
  const hits = await source.search({ text: "no match", files: ["a.ts"], fingerprint: "fp", limit: 2 });
  expect(hits.map(hit => hit.id)).toEqual(["new", "old"]);
  expect(hits[0]?.revision).toBe("new-sha");
  expect(JSON.parse((await source.fetch(hits[0]!)).content).trail.title).toBe("new");
});

test("Voxq proof distinguishes selected simulation from completed human respondents", () => {
  expect(personaProof(exported, "study", "sim", "report")).toEqual({
    kind: "persona_study", study: "study", runId: "sim", synthetic: true, report: "report",
  });
  expect(respondentProof(exported, { study: "study", runId: "collection", via: "embed",
    spendMicrousd: 30, expectMet: true, report: "report" })).toMatchObject({ kind: "voxq_study", respondents: 1 });
  expect(() => personaProof(exported, "study", "other", "report")).toThrow("unverified");
  expect(() => respondentProof({ ...exported, responses: [exported.responses[0]!] }, {
    study: "study", runId: "collection", via: "embed", spendMicrousd: 0, expectMet: true, report: "r",
  })).toThrow("unverified");
});

test("Voxq REST uses Rust routes, payloads, selected run and explicit authorization", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const client = new VoxqClient("https://voxq.test/", "secret", fake);
  await client.create({ name: "x", questions: [], personas: [], bots: [] }, "create-key");
  await client.estimate("s", ["prior"]);
  await client.simulate("s", "run-key");
  await client.publish("s", { by: "human", verdict: "approve", at: "2026-01-01T00:00:00Z" }, "publish-key");
  await client.results("s", "run id");
  await client.export("s", "run id");
  expect(calls.map(call => new URL(call.url).pathname)).toEqual([
    "/surveys", "/surveys/s/estimate", "/surveys/s/run", "/surveys/s/publish", "/surveys/s/results", "/surveys/s/export",
  ]);
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ history_survey_ids: ["prior"] });
  expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ accepting_interviews: true });
  expect(new URL(calls[5]!.url).searchParams.get("run_id")).toBe("run id");
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer secret");
  const failing = new VoxqClient("https://voxq.test", "secret", (async () => { throw Error("offline"); }) as typeof fetch);
  await expect(failing.simulate("s", "key")).rejects.toBeInstanceOf(ReconciliationRequired);
});
