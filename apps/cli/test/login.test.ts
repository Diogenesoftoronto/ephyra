import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  credentialsPath,
  loadCredentials,
  login,
  LoginCancelledError,
  LoginTimeoutError,
  userCode,
  type LoginEvent,
  type LoginIo,
} from "../src/login";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const session = { token: "private-session-token", did: "did:plc:reader", handle: "reader.example", approver: false };

async function fixture(overrides: Partial<LoginIo> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ephyra-cli-login-"));
  dirs.push(dir);
  const lines: string[] = [];
  const events: LoginEvent[] = [];
  const io: LoginIo = {
    env: { EPHYRA_CREDENTIALS: join(dir, "config", "credentials.json") },
    print: (line) => lines.push(line),
    onEvent: (event) => events.push(event),
    sleep: async () => {},
    fetch: (async () => Response.json(session)) as unknown as typeof fetch,
    ...overrides,
  };
  return { io, lines, events };
}

test("login binds its browser code to the verifier, polls, and saves a private session", async () => {
  let requestCount = 0;
  let approvalUrl = "";
  let verifier = "";
  const { io, lines, events } = await fixture({
    open: (url) => { approvalUrl = url; },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://console.example/auth/cli/token");
      expect(init?.method).toBe("POST");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      verifier = JSON.parse(String(init?.body)).verifier;
      return ++requestCount === 1 ? Response.json({ status: "pending" }, { status: 428 }) : Response.json(session);
    }) as unknown as typeof fetch,
    sleep: async (ms, signal) => {
      expect(ms).toBe(2000);
      expect(signal?.aborted).toBe(false);
    },
  });
  const result = await login("https://console.example/path", io);
  expect(requestCount).toBe(2);
  const challenge = new URL(approvalUrl).searchParams.get("cli")!;
  const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  expect(challenge).toBe(expected);
  expect(events[0]).toEqual({ type: "approval", url: approvalUrl, code: userCode(challenge) });
  expect(events.at(-1)).toEqual({
    type: "signed_in", url: "https://console.example", did: session.did, handle: session.handle,
    approver: false, credentialsPath: credentialsPath(io.env),
  });
  expect(result).toEqual({ url: "https://console.example", token: session.token, did: session.did, handle: session.handle });
  expect(await loadCredentials(io.env)).toEqual(result);
  expect((await stat(credentialsPath(io.env))).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(credentialsPath(io.env)))).mode & 0o777).toBe(0o700);
  expect(lines.join("\n")).toContain("read-only");
  expect(lines.join("\n")).toContain("Ctrl+C");
  expect(JSON.stringify({ events, lines })).not.toContain(session.token);
  expect(JSON.stringify({ events, lines })).not.toContain(verifier);
});

test("a missing browser opener leaves a usable link and continues polling", async () => {
  const { io, lines, events } = await fixture({ open: () => { throw new Error("desktop unavailable"); } });
  await login("https://console.example", io);
  expect(events.some((event) => event.type === "browser_unavailable")).toBe(true);
  expect(lines.join("\n")).toContain("Open the link above");
  expect(await loadCredentials(io.env)).not.toBeNull();
});

test("an already cancelled sign-in opens no browser and makes no request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private caller detail"));
  let requests = 0;
  let opened = false;
  const { io, lines, events } = await fixture({
    signal: controller.signal,
    open: () => { opened = true; },
    fetch: (async () => { requests++; return Response.json(session); }) as unknown as typeof fetch,
  });
  await expect(login("https://console.example", io)).rejects.toBeInstanceOf(LoginCancelledError);
  expect(requests).toBe(0);
  expect(opened).toBe(false);
  expect(lines).toEqual([]);
  expect(events).toEqual([]);
  expect(await loadCredentials(io.env)).toBeNull();
});

test("cancelling a pending fetch aborts it even when the transport never settles", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | null = null;
  const { io } = await fixture({
    signal: controller.signal,
    fetch: ((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init!.signal!;
      queueMicrotask(() => controller.abort());
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch,
  });
  await expect(login("https://console.example", io)).rejects.toBeInstanceOf(LoginCancelledError);
  expect((requestSignal as unknown as AbortSignal).aborted).toBe(true);
  expect(await loadCredentials(io.env)).toBeNull();
});

test("cancelling the polling delay prevents a second token request", async () => {
  const controller = new AbortController();
  let requests = 0;
  let delaySignal: AbortSignal | undefined;
  const { io } = await fixture({
    signal: controller.signal,
    fetch: (async () => { requests++; return Response.json({ status: "pending" }, { status: 428 }); }) as unknown as typeof fetch,
    sleep: (_ms, signal) => {
      delaySignal = signal;
      queueMicrotask(() => controller.abort());
      return new Promise<void>(() => {});
    },
  });
  await expect(login("https://console.example", io)).rejects.toBeInstanceOf(LoginCancelledError);
  expect(delaySignal?.aborted).toBe(true);
  expect(requests).toBe(1);
  expect(await loadCredentials(io.env)).toBeNull();
});

test("the total deadline covers a hung fetch and an unreadable response body", async () => {
  for (const stuck of ["fetch", "body"] as const) {
    let requestSignal: AbortSignal | null = null;
    const { io } = await fixture({
      fetch: ((_url: string | URL | Request, init?: RequestInit) => {
        requestSignal = init!.signal!;
        if (stuck === "fetch") return new Promise<Response>(() => {});
        return Promise.resolve({ status: 200, json: () => new Promise(() => {}) } as Response);
      }) as unknown as typeof fetch,
    });
    await expect(login("https://console.example", io, 25)).rejects.toBeInstanceOf(LoginTimeoutError);
    expect((requestSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(await loadCredentials(io.env)).toBeNull();
  }
});

test("cancelling while decoding a session cannot overwrite saved credentials", async () => {
  const controller = new AbortController();
  const { io } = await fixture({
    signal: controller.signal,
    fetch: (async () => ({
      status: 200,
      json: async () => { controller.abort(); return session; },
    } as Response)) as unknown as typeof fetch,
  });
  const oldPath = join(dirname(dirname(credentialsPath(io.env))), "previous.json");
  io.env.EPHYRA_CREDENTIALS = oldPath;
  const old = { url: "https://old.example", token: "old-private-token", did: "did:plc:old" };
  await writeFile(oldPath, JSON.stringify(old));
  await expect(login("https://console.example", io)).rejects.toBeInstanceOf(LoginCancelledError);
  expect(JSON.parse(await readFile(oldPath, "utf8"))).toEqual(old);
});

test("expired and pending approvals may be polled without claiming success", async () => {
  let requests = 0;
  const { io, events } = await fixture({
    fetch: (async () => ++requests < 3
      ? Response.json({ status: "pending" }, { status: requests === 1 ? 404 : 428 })
      : Response.json(session)) as unknown as typeof fetch,
  });
  await login("https://console.example", io);
  expect(requests).toBe(3);
  expect(events.filter((event) => event.type === "signed_in")).toHaveLength(1);
});

test("HTTP errors give next steps without exposing server response bodies", async () => {
  for (const [status, phrase] of [[403, "matching code"], [429, "Wait a moment"], [503, "server is healthy"]] as const) {
    const { io, events } = await fixture({
      fetch: (async () => Response.json({ error: "secret-upstream-diagnostic" }, { status })) as unknown as typeof fetch,
    });
    const error = await login("https://console.example", io).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(phrase);
    expect((error as Error).message).not.toContain("secret-upstream-diagnostic");
    expect(events.some((event) => event.type === "signed_in")).toBe(false);
    expect(await loadCredentials(io.env)).toBeNull();
  }
});

test("network failures redact transport details and do not retry an ambiguous collection", async () => {
  let requests = 0;
  const { io } = await fixture({
    fetch: (async () => { requests++; throw new Error("secret-proxy-credential"); }) as unknown as typeof fetch,
  });
  const error = await login("https://console.example", io).catch((error: Error) => error);
  expect((error as Error).message).toContain("Check your network");
  expect((error as Error).message).not.toContain("secret-proxy-credential");
  expect(requests).toBe(1);
  expect(await loadCredentials(io.env)).toBeNull();
});

test("invalid successful responses never create credentials", async () => {
  for (const value of [null, {}, { ...session, token: "" }, { ...session, did: null }, { ...session, approver: "true" }]) {
    const { io } = await fixture({ fetch: (async () => Response.json(value)) as unknown as typeof fetch });
    await expect(login("https://console.example", io)).rejects.toThrow("invalid session");
    expect(await loadCredentials(io.env)).toBeNull();
  }
});

test("terminal control sequences in account labels are cleaned before printing", async () => {
  const { io, lines } = await fixture({
    fetch: (async () => Response.json({ ...session, handle: "reader\u001b[2J\nforged line" })) as unknown as typeof fetch,
  });
  await login("https://console.example", io);
  const signed = lines.find((line) => line.startsWith("Signed in as"))!;
  expect(signed).not.toContain("\u001b");
  expect(signed).not.toContain("\n");
});

test("invalid URL and zero timeout fail before producing approval instructions", async () => {
  const { io, lines } = await fixture();
  await expect(login("not-a-url", io)).rejects.toThrow("full Ephyra server URL");
  await expect(login("file:///tmp/server", io)).rejects.toThrow("full Ephyra server URL");
  await expect(login("https://console.example", io, 0)).rejects.toBeInstanceOf(LoginTimeoutError);
  expect(lines).toEqual([]);
});
