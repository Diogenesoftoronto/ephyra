import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../http/app";
import { consoleRoutes } from "../http/console";
import { MemoryRunStore, RunBroker, RunRecorder } from "../runs";
import { MemoryUsageStore } from "../usage";
import { MemoryAccountStore } from "./account-store";
import { workspaceId } from "./accounts";
import { Teams } from "./team";
import { forwardSharedRequest } from "./team-stream";

const OWNER = "did:plc:owner", VIEWER = "did:plc:viewer";
async function authority() {
  const teams = new Teams(new MemoryAccountStore(), "test-secret".repeat(4));
  const workspace = workspaceId(OWNER);
  const invitation = await teams.invite(OWNER, { expectedVersion: 0, workspaceId: workspace, label: "Viewer", role: "viewer" }, "invite-key-0001");
  await teams.accept(VIEWER, invitation.token, "accept-key-0001");
  const allowed = () => teams.stillShared(OWNER, workspace, VIEWER, invitation.invitationId!);
  const revoke = () => teams.revoke(OWNER, { expectedVersion: 2, workspaceId: workspace, id: invitation.invitationId! }, "revoke-key-0001");
  return { teams, allowed, revoke };
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("stream did not close")), 1000); })]); }
  finally { clearTimeout(timer!); }
}

test("revocation closes an idle real run SSE stream and releases its broker wait", async () => {
  const a = await authority();
  const runs = new MemoryRunStore(), broker = new RunBroker();
  const recorder = new RunRecorder(runs, broker);
  await recorder.start({ id: "shared-run", trailId: null, short: null, step: "research", persona: "bell",
    engine: "offline/test", executor: { kind: "local" } });
  let waits = 0;
  const original = broker.wait.bind(broker);
  broker.wait = async (...args) => { waits++; try { await original(...args); } finally { waits--; } };
  const port = { runs, broker, usage: new MemoryUsageStore(), trails: async () => [], activity: async () => [],
    docs: {} as never, drafts: {} as never, now: () => new Date() };
  const token = "s".repeat(32);
  const app = createApp(token, {} as never, new Hono(), undefined, { requireSignIn: false, approvers: new Set() }, (approval) => consoleRoutes(port, approval));
  let upstreamSignal: AbortSignal | undefined;
  const response = await forwardSharedRequest(new Request("https://app.test/v1/runs/shared-run/events", { headers: {
    Authorization: `Bearer ${token}`, "X-Ephyra-Principal": VIEWER, Accept: "text/event-stream",
  } }), (request) => { upstreamSignal = request.signal; return app.fetch(request); }, a.allowed, 10);
  const reader = response.body!.getReader();
  let initial = new TextDecoder().decode((await reader.read()).value);
  expect(initial).toContain("retry:");
  // The initial snapshot is already authorized and may be queued before revocation. Drain it to reach an idle stream.
  while (!initial.includes("event: run_state")) initial += new TextDecoder().decode((await bounded(reader.read())).value);
  expect(initial).toContain('"status":"running"');
  await a.revoke();
  expect((await bounded(reader.read())).done).toBe(true);
  expect(upstreamSignal?.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(waits).toBe(0);
});

test("a newly produced chunk is checked again before forwarding and revoked content is dropped", async () => {
  const a = await authority();
  let source: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const response = await forwardSharedRequest(new Request("https://app.test/events"), () => new Response(new ReadableStream<Uint8Array>({
    start(value) { source = value; }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }), a.allowed, 500);
  const reader = response.body!.getReader();
  const next = reader.read();
  await a.revoke();
  source!.enqueue(new TextEncoder().encode("data: private new event\n\n"));
  expect((await bounded(next)).done).toBe(true);
  expect(cancelled).toBe(true);
});

test("downstream cancellation aborts the producer; denied requests never start one", async () => {
  let cancelled = false, signal: AbortSignal | undefined, calls = 0;
  const forward = (request: Request) => {
    calls++; signal = request.signal;
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  };
  expect((await forwardSharedRequest(new Request("https://app.test/events"), forward, async () => false)).status).toBe(403);
  expect(calls).toBe(0);
  const response = await forwardSharedRequest(new Request("https://app.test/events"), forward, async () => true, 10);
  await response.body!.cancel();
  expect(cancelled).toBe(true);
  expect(signal?.aborted).toBe(true);
});

test("authority failures close streams without exposing internal errors", async () => {
  let checks = 0;
  const response = await forwardSharedRequest(new Request("https://app.test/events"), () => new Response(new ReadableStream(), {
    headers: { "content-type": "text/event-stream" },
  }), async () => {
    if (++checks > 2) throw new Error("database credential must stay private");
    return true;
  }, 10);
  expect(await bounded(response.text())).toBe("");
});
