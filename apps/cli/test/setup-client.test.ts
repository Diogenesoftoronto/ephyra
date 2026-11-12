import { afterEach, expect, spyOn, test } from "bun:test";
import type { AccountSettings, RepositoryUpdate, SetupRun } from "@ephyra/core";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliSetupClient, SetupApiError, SetupWriteUnknown } from "../src/commands/setup-client";
import { setupReceipts, type SetupPending } from "../src/commands/setup-receipt";

const origin = "https://console.example";
const did = "did:plc:owner";
const key = "setup:12345678-1234-4234-8234-123456789abc";
const otherKey = "setup:87654321-1234-4234-8234-123456789abc";
const repository = { url: "https://git.example/team/app.git", branch: "main", head: "a".repeat(40) };
const update: RepositoryUpdate = { expectedVersion: 3, url: repository.url, branch: "main", clearToken: true };
const account = (extra: Partial<AccountSettings> = {}): AccountSettings => ({
  did, version: 3, workspaceId: "ws-before", repository: null,
  model: { provider: "none", model: "", baseUrl: null, keyConfigured: false, status: "not_configured", checkedAt: null, detail: null },
  onboarding: { status: "new", updatedAt: "2026-11-12T00:00:00Z" }, execution: "not_configured", ...extra,
});
const run = (extra: Partial<SetupRun> = {}): SetupRun => ({
  id: "setup-run", operationKey: key, mode: "autonomous", status: "queued", repository,
  startedAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z", steps: [], artifacts: [], blockers: [], ...extra,
});

type RecordedRequest = { url: URL; init: RequestInit; headers: Headers };
function fixture(respond: (request: RecordedRequest, count: number) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = { url: new URL(String(url)), init: init!, headers: new Headers(init?.headers) };
    requests.push(request);
    return respond(request, requests.length);
  }) as unknown as typeof fetch;
  return { client: new CliSetupClient(origin, "private-session-token", did, fetcher), requests };
}

test("setup requests pin the owner and workspace, then follow the workspace returned by a repository save", async () => {
  const next = account({ version: 4, workspaceId: "ws-after" });
  const { client, requests } = fixture((_request, count) => Response.json([
    account(), next, { providers: ["sentry", "bugsnag"] }, run(),
  ][count - 1]));
  await client.settings();
  expect(client.workspace).toBe("ws-before");
  expect(await client.saveRepository(update, key)).toEqual(next);
  expect(client.workspace).toBe("ws-after");
  expect(await client.detectedTelemetry()).toEqual(["sentry", "bugsnag"]);
  expect(await client.start("autonomous", key)).toEqual(run());
  expect(requests.map((request) => request.headers.get("X-Ephyra-Workspace"))).toEqual([null, "ws-before", "ws-after", "ws-after"]);
  for (const request of requests) {
    expect(request.headers.get("X-Ephyra-Account")).toBe(did);
    expect(request.headers.get("Authorization")).toBe("Bearer private-session-token");
    expect(request.init.cache).toBe("no-store");
    expect(request.init.redirect).toBe("error");
    expect(request.init.signal).toBeInstanceOf(AbortSignal);
  }
  const saved = requests[1]!;
  expect(saved.url.pathname).toBe("/v1/account/repository");
  expect(saved.init.method).toBe("PUT");
  expect(saved.headers.get("Idempotency-Key")).toBe(key);
  expect(saved.headers.get("Content-Type")).toBe("application/json");
  expect(JSON.parse(String(saved.init.body))).toEqual(update);
  expect(requests[3]!.init.method).toBe("POST");
  expect(JSON.parse(String(requests[3]!.init.body))).toEqual({ mode: "autonomous" });
});

test("foreign account responses cannot replace the pinned workspace", async () => {
  const { client, requests } = fixture((_request, count) => Response.json(count === 1
    ? account() : account({ did: "did:plc:someone-else", workspaceId: "foreign-workspace" })));
  await client.settings();
  await expect(client.settings()).rejects.toThrow("unreadable setup progress");
  expect(client.workspace).toBe("ws-before");
  const error = await client.saveRepository(update, key).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(SetupWriteUnknown);
  expect((error as SetupWriteUnknown).operationKey).toBe(key);
  expect(client.workspace).toBe("ws-before");
  expect(requests).toHaveLength(3);
});

test("an explicit browser handoff refreshes the workspace without dropping the account pin", async () => {
  const { client, requests } = fixture((_request, count) => Response.json([
    account(), account({ version: 4, workspaceId: "ws-from-browser" }),
    account({ did: "did:plc:foreign", workspaceId: "foreign-workspace" }), null,
  ][count - 1]));
  await client.settings();
  await client.settings(true);
  expect(client.workspace).toBe("ws-from-browser");
  await expect(client.settings(true)).rejects.toThrow("unreadable setup progress");
  expect(client.workspace).toBe("ws-from-browser");
  await client.current();
  expect(requests.map(request => request.headers.get("X-Ephyra-Workspace"))).toEqual([null, null, null, "ws-from-browser"]);
  expect(requests.every(request => request.headers.get("X-Ephyra-Account") === did)).toBe(true);
});

test("invalid repository versions fail before dispatch, and key lookups encode the exact key without a fallback read", async () => {
  const { client, requests } = fixture(() => Response.json(null));
  expect(() => client.saveRepository({ ...update, expectedVersion: -1 }, key)).toThrow();
  expect(requests).toHaveLength(0);
  const lookupKey = "setup:exact&other=ignored/#?";
  expect(await client.current(lookupKey)).toBeNull();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url.pathname).toBe("/v1/setup");
  expect([...requests[0]!.url.searchParams]).toEqual([["operationKey", lookupKey]]);
  expect(requests[0]!.init.method).toBe("GET");
});

test("an exact-key read refuses another operation's run rather than accepting or silently fetching the latest", async () => {
  for (const operationKey of [undefined, otherKey]) {
    const { client, requests } = fixture(() => Response.json(run({ operationKey })));
    await expect(client.current(key)).rejects.toThrow("unreadable setup progress");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.searchParams.get("operationKey")).toBe(key);
  }
});

test("a start is unconfirmed when its response is malformed, lacks a key or names a different operation", async () => {
  for (const response of [
    () => new Response("not-json"),
    () => Response.json({ status: "ready" }),
    () => Response.json(run({ operationKey: undefined })),
    () => Response.json(run({ operationKey: otherKey })),
  ]) {
    const { client, requests } = fixture(response);
    const error = await client.start("supervised", key).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SetupWriteUnknown);
    expect((error as SetupWriteUnknown).operationKey).toBe(key);
    expect(requests).toHaveLength(1);
  }
});

test("definite HTTP refusals stay distinct from ambiguous writes, with no retries or upstream error disclosure", async () => {
  for (const method of ["setup", "repository"] as const) {
    for (const status of [401, 403, 404, 409, 422, 500, 503]) {
      const { client, requests } = fixture(() => Response.json({ error: "private-provider-diagnostic" }, { status }));
      const error = await (method === "setup" ? client.start("autonomous", key) : client.saveRepository(update, key))
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(status >= 500 ? SetupWriteUnknown : SetupApiError);
      if (error instanceof SetupApiError) expect(error.status).toBe(status);
      if (error instanceof SetupWriteUnknown) expect(error.operationKey).toBe(key);
      expect((error as Error).message).not.toContain("private-provider-diagnostic");
      expect(requests).toHaveLength(1);
    }
  }
  const { client, requests } = fixture(() => { throw new Error("private-network-credential"); });
  const error = await client.saveRepository(update, key).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(SetupWriteUnknown);
  expect((error as Error).message).not.toContain("private-network-credential");
  expect(requests).toHaveLength(1);
});

test("timeouts abort the transport and leave writes unconfirmed; cancellation before dispatch makes no write", async () => {
  const nativeTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => { timeouts.push(ms); return nativeTimeout(5); });
  try {
    const { client, requests } = fixture(({ init }) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    await expect(client.start("autonomous", key)).rejects.toBeInstanceOf(SetupWriteUnknown);
    await expect(client.current(key)).rejects.toThrow("could not be reached");
    expect(timeouts).toEqual([120_000, 30_000]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.init.signal?.aborted)).toBe(true);
  } finally { timeout.mockRestore(); }
  let called = false;
  const signal = AbortSignal.abort();
  const fetcher = (async () => { called = true; return Response.json(run()); }) as unknown as typeof fetch;
  const client = new CliSetupClient(origin, "private", did, fetcher, signal);
  await expect(client.start("autonomous", key)).rejects.toThrow();
  expect(called).toBe(false);
});

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function receiptFixture() {
  const dir = await mkdtemp(join(tmpdir(), "ephyra-setup-receipt-"));
  dirs.push(dir);
  const config = join(dir, "config");
  const env = { EPHYRA_CREDENTIALS: join(config, "credentials.json"), EPHYRA_API_TOKEN: "private-service-token" };
  return { config, env, receipts: setupReceipts(origin, did, env) };
}

test("pending receipts are private and store reconciliation facts without account credentials", async () => {
  const { receipts, config, env } = await receiptFixture();
  expect(await receipts.read()).toBeNull();
  const pending: SetupPending = { kind: "repository", key, workspace: "ws-before", version: 3, url: repository.url, branch: null };
  const unexpected = { ...pending, token: "private-repository-token", credentials: { apiKey: "private-key" } };
  await receipts.claim(unexpected);
  const files = await readdir(config);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^setup-[a-f0-9]{32}\.json$/);
  const path = join(config, files[0]!);
  const raw = await readFile(path, "utf8");
  expect(JSON.parse(raw)).toEqual(pending);
  expect(raw).not.toContain(env.EPHYRA_API_TOKEN);
  expect(raw).not.toContain(unexpected.token);
  expect(raw).not.toContain(unexpected.credentials.apiKey);
  expect(raw).not.toContain("Authorization");
  expect(raw).not.toContain(did);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(config)).mode & 0o777).toBe(0o700);
  expect(await setupReceipts(origin, did, env).read()).toEqual(pending);
  // Old or foreign files cannot surface unrecognized secret fields on resume either.
  await writeFile(path, JSON.stringify(unexpected));
  expect(await receipts.read()).toEqual(pending);
});

test("concurrent receipt claims are exclusive across instances, and only the matching key can clear one", async () => {
  const { receipts, env } = await receiptFixture();
  const other = setupReceipts(origin, did, env);
  const attempts = await Promise.allSettled([
    receipts.claim({ kind: "setup", key, workspace: "ws-before" }),
    other.claim({ kind: "setup", key: otherKey, workspace: "ws-before" }),
  ]);
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const refusal = attempts.find(result => result.status === "rejected") as PromiseRejectedResult;
  expect(refusal.reason.message).toMatch(/Another setup change is pending|Setup receipt is busy/);
  const winner = await receipts.read();
  expect(winner).not.toBeNull();
  expect(await other.read()).toEqual(winner);
  await other.clear(winner!.key === key ? otherKey : key);
  expect(await receipts.read()).toEqual(winner);
  await other.clear(winner!.key);
  expect(await receipts.read()).toBeNull();
  await receipts.claim({ kind: "setup", key, workspace: "ws-before" });
  expect((await receipts.read())?.key).toBe(key);
});

test("malformed receipts block reads, clearing and replacement without exposing their contents", async () => {
  const { receipts, config } = await receiptFixture();
  const pending: SetupPending = { kind: "setup", key, workspace: "ws-before" };
  await receipts.claim(pending);
  const path = join(config, (await readdir(config))[0]!);
  for (const raw of [
    "private-token-not-json",
    JSON.stringify({ ...pending, key: "private-token-invalid-key" }),
    JSON.stringify({ ...pending, kind: "repository", version: -1, url: repository.url, branch: "main" }),
  ]) {
    await writeFile(path, raw);
    const error = await receipts.read().catch((error: unknown) => error);
    expect((error as Error).message).toContain("unreadable pending receipt");
    expect((error as Error).message).not.toContain("private-token");
    await expect(receipts.clear(key)).rejects.toThrow("unreadable pending receipt");
    await expect(receipts.claim(pending)).rejects.toThrow("Another setup change is pending");
    expect(await readFile(path, "utf8")).toBe(raw);
  }
});

test("pending receipts are isolated by both account and server", async () => {
  const { receipts, env } = await receiptFixture();
  await receipts.claim({ kind: "setup", key, workspace: "ws-before" });
  expect(await setupReceipts(origin, "did:plc:other", env).read()).toBeNull();
  expect(await setupReceipts("https://another.example", did, env).read()).toBeNull();
});

test("a held receipt lock prevents reads, replacement and clearing until explicitly reconciled", async () => {
  const { receipts, config, env } = await receiptFixture();
  const pending: SetupPending = { kind: "setup", key, workspace: "ws-before" };
  await receipts.claim(pending);
  const path = join(config, (await readdir(config))[0]!);
  const raw = await readFile(path, "utf8");
  await mkdir(`${path}.lock`);
  const other = setupReceipts(origin, did, env);
  await expect(other.read()).rejects.toThrow("receipt is busy");
  await expect(other.claim({ ...pending, key: otherKey })).rejects.toThrow("receipt is busy");
  await expect(other.clear(key)).rejects.toThrow("receipt is busy");
  expect(await readFile(path, "utf8")).toBe(raw);
  expect((await stat(`${path}.lock`)).isDirectory()).toBe(true);
  await rm(`${path}.lock`, { recursive: true });
  expect(await receipts.read()).toEqual(pending);
});

test("repository receipts reject credential-bearing addresses before creating a pending file", async () => {
  const { receipts, config } = await receiptFixture();
  for (const url of ["https://token:private@git.example/repo.git", "https://git.example/repo.git?token=private", "https://git.example/repo.git#private"]) {
    await expect(receipts.claim({ kind: "repository", key, workspace: "ws-before", version: 3, url, branch: "main" }))
      .rejects.toThrow("Invalid repository receipt");
    expect(await readdir(config)).toEqual([]);
  }
});
