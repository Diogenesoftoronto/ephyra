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

test("session identity reports server-derived permissions for humans and machines", async () => {
  const { Hono } = await import("hono");
  const app = createApp("service", port, new Hono(), async (token) =>
    token === "reader" || token === "approver" ? { did: `did:example:${token}` } : null,
    { requireSignIn: true, approvers: new Set(["did:example:approver"]) });
  const me = async (token: string) => (await app.request("/v1/me", {
    headers: { Authorization: `Bearer ${token}`, "X-Ephyra-Principal": "spoofed" },
  })).json();
  expect(await me("reader")).toEqual({ principal: "did:example:reader", kind: "human", approver: false });
  expect(await me("approver")).toEqual({ principal: "did:example:approver", kind: "human", approver: true });
  expect(await me("service")).toEqual({ principal: "spoofed", kind: "service", approver: false });
  expect((await app.request("/v1/me")).status).toBe(401);
});
