// `ephyra login`: sign in with Not Organic through the browser, then keep the session in a local credentials file.
// The CLI never sees Not Organic tokens; it holds only an Ephyra session token, released after browser approval.
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { oneLine } from "./inbox/text";

export type Credentials = { url: string; token: string; did: string; handle?: string | null };

export function credentialsPath(env: Record<string, string | undefined> = process.env): string {
  return env.EPHYRA_CREDENTIALS ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ephyra", "credentials.json");
}

export async function loadCredentials(env: Record<string, string | undefined> = process.env): Promise<Credentials | null> {
  try {
    const value = JSON.parse(await readFile(credentialsPath(env), "utf8")) as Credentials;
    return typeof value.url === "string" && typeof value.token === "string" ? value : null;
  } catch {
    return null;
  }
}

async function saveCredentials(creds: Credentials, env: Record<string, string | undefined>): Promise<string> {
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Same derivation as the server's approval page, so the user can check they match. */
export function userCode(challenge: string): string {
  const c = challenge.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `${c.slice(0, 4)}-${c.slice(4, 8)}`;
}

/** Presentation events contain no session token or PKCE verifier. */
export type LoginEvent =
  | { type: "approval"; url: string; code: string }
  | { type: "waiting" }
  | { type: "browser_unavailable" }
  | {
      type: "signed_in";
      url: string;
      did: string;
      handle: string | null;
      approver: boolean;
      credentialsPath: string;
    };

export class LoginCancelledError extends Error {
  constructor() {
    super("Sign-in cancelled. No new credentials were saved.");
    this.name = "LoginCancelledError";
  }
}

export class LoginTimeoutError extends Error {
  constructor() {
    super("Sign-in timed out. Run `ephyra login <server-url>` again and approve the matching code in your browser.");
    this.name = "LoginTimeoutError";
  }
}

export type LoginIo = {
  print(line: string): void;
  open?(url: string): void | Promise<void>;
  /** Implementations should honour the signal so cancellation also releases their timer. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  onEvent?(event: LoginEvent): void;
};

/** Bound even injected I/O that does not honour AbortSignal; the real fetch also receives the signal. */
function untilStopped<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

function loginFailure(status: number): Error {
  if (status === 401 || status === 403)
    return new Error(`Sign-in was refused (${status}). Check that you approved the matching code with an account allowed on this server.`);
  if (status === 429)
    return new Error("Too many sign-in requests (429). Wait a moment, then run `ephyra login <server-url>` again.");
  if (status >= 500)
    return new Error(`The sign-in server is unavailable (${status}). Try again once the server is healthy.`);
  return new Error(`Sign-in failed (${status}). Check the server address and run \`ephyra login <server-url>\` again.`);
}

function approvedSession(value: unknown): { token: string; did: string; handle: string | null; approver: boolean } {
  if (!value || typeof value !== "object") throw new Error("The sign-in server returned an invalid session. No credentials were saved.");
  const body = value as Record<string, unknown>;
  if (
    typeof body.token !== "string" || !body.token || typeof body.did !== "string" || !body.did ||
    (body.handle !== null && typeof body.handle !== "string") || typeof body.approver !== "boolean"
  ) throw new Error("The sign-in server returned an invalid session. No credentials were saved.");
  return { token: body.token, did: body.did, handle: body.handle, approver: body.approver };
}

export async function login(serverUrl: string, io: LoginIo, timeoutMs = 10 * 60_000): Promise<Credentials> {
  if (io.signal?.aborted) throw new LoginCancelledError();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Sign-in timeout must be a finite, non-negative number.");
  if (timeoutMs === 0) throw new LoginTimeoutError();
  let server: URL;
  try {
    server = new URL(serverUrl);
    if (server.protocol !== "https:" && server.protocol !== "http:") throw new Error();
  } catch {
    throw new Error("Enter a full Ephyra server URL, such as https://console.ephyra.quest.");
  }
  const base = server.origin;
  const controller = new AbortController();
  const { signal } = controller;
  const cancel = () => controller.abort(new LoginCancelledError());
  io.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new LoginTimeoutError()), timeoutMs);
  const deadline = Date.now() + timeoutMs;
  try {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = await untilStopped(() => challengeFor(verifier), signal);
    const url = `${base}/auth/login?cli=${challenge}`;
    const code = userCode(challenge);
    io.print(`Open this link to sign in with Not Organic:\n\n  ${url}\n`);
    io.print(`Approve only the request showing code ${code}.`);
    io.onEvent?.({ type: "approval", url, code });
    if (io.open) {
      try {
        await untilStopped(() => Promise.resolve(io.open!(url)), signal);
      } catch (error) {
        signal.throwIfAborted();
        io.print("The browser could not be opened. Open the link above in your browser to continue.");
        io.onEvent?.({ type: "browser_unavailable" });
      }
    }
    io.print("Waiting for browser approval. Press Ctrl+C to cancel.");
    io.onEvent?.({ type: "waiting" });
    while (Date.now() < deadline) {
      let res: Response;
      try {
        res = await untilStopped(() => io.fetch(`${base}/auth/cli/token`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verifier }), signal,
        }), signal);
      } catch (error) {
        signal.throwIfAborted();
        throw new Error("The sign-in connection was interrupted. Check your network and server address, then run `ephyra login <server-url>` again.");
      }
      if (res.status === 200) {
        let value: unknown;
        try {
          value = await untilStopped(() => res.json(), signal);
        } catch (error) {
          signal.throwIfAborted();
          throw new Error("The sign-in server returned an unreadable session. No credentials were saved.");
        }
        const body = approvedSession(value);
        const creds: Credentials = { url: base, token: body.token, did: body.did, handle: body.handle };
        signal.throwIfAborted();
        // Once saving begins it is the commit point: finish reporting success rather than claiming cancellation.
        clearTimeout(timeout);
        io.signal?.removeEventListener("abort", cancel);
        const path = await saveCredentials(creds, io.env);
        io.print(`Signed in as ${oneLine(body.handle ?? body.did)}${body.approver ? "" : " (read-only: not an approver on this server)"}.`);
        io.print(`Saved to ${oneLine(path)}.`);
        io.onEvent?.({ type: "signed_in", url: base, did: body.did, handle: body.handle, approver: body.approver, credentialsPath: path });
        return creds;
      }
      if (res.status !== 428 && res.status !== 404) throw loginFailure(res.status);
      await untilStopped(() => io.sleep(Math.min(2000, Math.max(0, deadline - Date.now())), signal), signal);
    }
    throw new LoginTimeoutError();
  } finally {
    clearTimeout(timeout);
    io.signal?.removeEventListener("abort", cancel);
  }
}

export async function logout(io: Pick<LoginIo, "fetch" | "env" | "print">): Promise<void> {
  const creds = await loadCredentials(io.env);
  if (!creds) { io.print("Not signed in."); return; }
  await io.fetch(`${creds.url}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${creds.token}` } }).catch(() => undefined);
  await rm(credentialsPath(io.env), { force: true });
  io.print("Signed out.");
}
