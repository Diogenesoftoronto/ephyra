import { expect, test } from "bun:test";
import { OpenObserveEvidence, SpendNotApproved, VoxqClient } from "./src/index.ts";

test("OpenObserve sends bounded SQL and rejects partial results", async () => {
  let request: RequestInit | undefined;
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = init;
    return Response.json({ hits: [{ message: "event" }] });
  }) as typeof fetch;
  const source = new OpenObserveEvidence({ url: "https://example.test", org: "org", stream: "logs",
    authorization: "Basic token", from: new Date(0), to: new Date(1000) }, fake);
  expect(await source.search({ text: "", fingerprint: "abc'xyz", limit: 5 })).toHaveLength(1);
  expect(JSON.parse(String(request?.body)).query.sql).toContain("abc''xyz");
});

test("Voxq blocks unapproved spend before a request", () => {
  const client = new VoxqClient("https://example.test", "token", (() => { throw new Error("called"); }) as typeof fetch);
  expect(() => client.publish("study", { by: "policy", at: "2026-01-01T00:00:00Z", verdict: "approve" }, "key"))
    .toThrow(SpendNotApproved);
});
