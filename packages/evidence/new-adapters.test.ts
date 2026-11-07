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


test("OpenObserve route and trace queries use the documented request and surface gaps", async () => {
  const requests: { url: string; body: any; auth: string | null }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ hits: [] });
  }) as typeof fetch;
  const opts = { url: "https://example.test", org: "my org", stream: "logs", authorization: "Basic abc",
    from: new Date(1000), to: new Date(2000) };
  const source = new OpenObserveEvidence(opts, fake);
  await source.search({ text: "", route: "/orders", limit: 7 });
  await source.search({ text: "", traceId: "trace-1", limit: 4 });
  expect(requests[0]?.url).toBe("https://example.test/api/my%20org/_search");
  expect(requests[0]?.auth).toBe("Basic abc");
  expect(requests[0]?.body.query).toEqual({ sql: `SELECT * FROM "logs" WHERE "route" = '/orders'`,
    start_time: 1000000, end_time: 2000000, from: 0, size: 7 });
  expect(requests[1]?.body.query.sql).toContain(`"trace_id" = 'trace-1'`);
  const incomplete = new OpenObserveEvidence(opts, (async () => Response.json({ hits: [], is_partial: true })) as typeof fetch);
  await expect(incomplete.search({ text: "x", limit: 1 })).rejects.toThrow("unverified");
});
