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
