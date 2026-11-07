// `ephyra login`: sign in with Not Organic through the browser, then keep the session in a local credentials file.
// The CLI never sees Not Organic tokens; it holds only an Ephyra session token, released after browser approval.
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

export type LoginIo = {
  print(line: string): void;
  open?(url: string): void;
  sleep(ms: number): Promise<void>;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
};

export async function login(serverUrl: string, io: LoginIo, timeoutMs = 10 * 60_000): Promise<Credentials> {
  const base = new URL(serverUrl).origin;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await challengeFor(verifier);
  const url = `${base}/auth/login?cli=${challenge}`;
  io.print(`Open this link to sign in with Not Organic:\n\n  ${url}\n`);
  io.print(`Then approve the request showing code ${userCode(challenge)}.`);
  io.open?.(url);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await io.fetch(`${base}/auth/cli/token`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verifier }),
    });
    if (res.status === 200) {
      const body = (await res.json()) as { token: string; did: string; handle: string | null; approver: boolean };
      const creds: Credentials = { url: base, token: body.token, did: body.did, handle: body.handle };
      const path = await saveCredentials(creds, io.env);
      io.print(`Signed in as ${body.handle ?? body.did}${body.approver ? "" : " (read-only: not an approver on this server)"}.`);
      io.print(`Saved to ${path}.`);
      return creds;
    }
    if (res.status !== 428 && res.status !== 404) throw new Error(`sign-in failed (${res.status})`);
    await io.sleep(2000);
  }
  throw new Error("sign-in timed out; run `ephyra login` again");
}

export async function logout(io: Pick<LoginIo, "fetch" | "env" | "print">): Promise<void> {
  const creds = await loadCredentials(io.env);
  if (!creds) { io.print("Not signed in."); return; }
  await io.fetch(`${creds.url}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${creds.token}` } }).catch(() => undefined);
  await rm(credentialsPath(io.env), { force: true });
  io.print("Signed out.");
}
