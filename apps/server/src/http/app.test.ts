import { expect, test } from "bun:test";
import { createApp, StaleApproval, type HttpPort } from "./app.ts";

const port: HttpPort = {
  inbox: async () => [], trails: async () => [], trail: async () => null,
  decide: async () => { throw new StaleApproval(); }, action: async () => {},
};

test("authentication requires token and explicit principal", async () => {
  const app = createApp("secret", port);
  expect((await app.request("/v1/inbox")).status).toBe(401);
  expect((await app.request("/v1/inbox", { headers: { Authorization: "Bearer wrong", "X-Ephyra-Principal": "a" } })).status).toBe(401);
  expect((await app.request("/v1/inbox", { headers: { Authorization: "Bearer secret", "X-Forwarded-User": "admin" } })).status).toBe(401);
  expect((await app.request("/v1/inbox", { headers: { Authorization: "Bearer secret", "X-Ephyra-Principal": "a" } })).status).toBe(200);
});

test("stale approvals return conflict", async () => {
  const app = createApp("secret", port);
  const response = await app.request("/v1/trails/t/decide", {
    method: "POST", headers: { Authorization: "Bearer secret", "X-Ephyra-Principal": "a", "Content-Type": "application/json" },
    body: JSON.stringify({ checkpoint: "A", verdict: "approve" }),
  });
  expect(response.status).toBe(409);
});

const H = { Authorization: "Bearer secret", "X-Ephyra-Principal": "a" };
const files: Record<string, string> = { "t1:hypothesis.md": "# Hypothesis\nRounding runs per line item.", "t1:evidence/index.json": "[]" };
const filePort: HttpPort = { ...port, file: async (id, path) => (files[`${id}:${path}`] ? new TextEncoder().encode(files[`${id}:${path}`]) : null) };

test("journal files: allow-listed paths only, behind auth, served as text", async () => {
  const app = createApp("secret", filePort);
  expect((await app.request("/v1/trails/t1/file?path=hypothesis.md")).status).toBe(401);
  const ok = await app.request("/v1/trails/t1/file?path=hypothesis.md", { headers: H });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toStartWith("text/markdown");
  expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await ok.text()).toContain("Rounding runs per line item.");
  expect((await app.request("/v1/trails/t1/file?path=evidence/index.json", { headers: H })).headers.get("content-type")).toStartWith("application/json");
  expect((await app.request("/v1/trails/t1/file?path=plan.md", { headers: H })).status).toBe(404);
  expect((await app.request("/v1/trails/t9/file?path=hypothesis.md", { headers: H })).status).toBe(404);
  for (const bad of ["", "trail.json", "../hypothesis.md", "artefacts/research/../../x", "/etc/passwd", "artefacts/x", "events/1.json", "hypothesis.md/x"]) {
    expect((await app.request(`/v1/trails/t1/file?path=${encodeURIComponent(bad)}`, { headers: H })).status).toBe(400);
  }
});

test("journal files: too large is refused, and ports without files say so", async () => {
  const big: HttpPort = { ...port, file: async () => new Uint8Array(256 * 1024 + 1) };
  expect((await createApp("secret", big).request("/v1/trails/t1/file?path=plan.md", { headers: H })).status).toBe(413);
  expect((await createApp("secret", port).request("/v1/trails/t1/file?path=plan.md", { headers: H })).status).toBe(501);
});
