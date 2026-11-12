// "Connect with GitHub": a GitHub App gives each workspace short-lived, repository-scoped tokens. Nobody pastes a token.
//
// Operator side, once (feature flag: all three EPHYRA_GITHUB_APP_* variables set):
//   1. Open /github/app/new (operator only). It posts a manifest to GitHub; one click creates the app.
//   2. GitHub redirects to /github/app/created?code=…; the server exchanges the code and shows the three values to set.
// User side: Settings → Repository → "Connect with GitHub" opens the app's install page. GitHub redirects to
// /github/install/callback with an installation id; the server checks the installation covers the workspace repository
// and stores only the installation id. Each API call mints an installation token (one hour) for that one repository.
import { createSign } from "node:crypto";
import { Unverified } from "@ephyra/core";

export type GitHubAppConfig = { appId: string; slug: string; privateKey: string };
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.github.com";
const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** The app config when the feature flag is complete, otherwise null (the console then hides "Connect with GitHub"). */
export function githubAppConfig(env: { EPHYRA_GITHUB_APP_ID?: string; EPHYRA_GITHUB_APP_SLUG?: string; EPHYRA_GITHUB_APP_PRIVATE_KEY?: string }):
  GitHubAppConfig | null {
  const { EPHYRA_GITHUB_APP_ID: appId, EPHYRA_GITHUB_APP_SLUG: slug, EPHYRA_GITHUB_APP_PRIVATE_KEY: key } = env;
  if (!appId || !slug || !key) return null;
  if (!/^\d{1,12}$/.test(appId) || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw new Error("invalid EPHYRA_GITHUB_APP_ID or _SLUG");
  // Railway variables often hold a PEM with literal "\n"; accept both.
  return { appId, slug, privateKey: key.includes("-----BEGIN") ? key.replace(/\\n/g, "\n") : Buffer.from(key, "base64").toString("utf8") };
}

/** The manifest GitHub uses to create the app: only the permissions Ephyra uses, no webhook. */
export function appManifest(origin: string, name = "Ephyra") {
  return {
    name, url: origin, public: true,
    redirect_url: `${origin}/github/app/created`,
    setup_url: `${origin}/github/install/callback`, setup_on_update: true,
    callback_urls: [`${origin}/github/install/callback`],
    hook_attributes: { url: `${origin}/github/webhook`, active: false },
    default_permissions: { contents: "write", pull_requests: "write", checks: "read", statuses: "read", metadata: "read" },
    default_events: [],
  };
}

/** A 9-minute RS256 app JWT, issued 60 s in the past to tolerate clock skew. */
export function appJwt(config: GitHubAppConfig, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: config.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(signer.sign(config.privateKey))}`;
}

async function github(fetcher: Fetch, path: string, init: RequestInit & { auth: string }): Promise<Response> {
  const { auth, ...rest } = init;
  return fetcher(`${API}${path}`, { ...rest, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ephyra",
      Authorization: auth, ...(rest.body ? { "Content-Type": "application/json" } : {}) } });
}

/** Exchange the one-time manifest code for the new app's id, slug and private key. */
export async function convertManifest(code: string, fetcher: Fetch = fetch) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new Unverified("GitHub app creation code");
  const response = await fetcher(`${API}/app-manifests/${code}/conversions`, { method: "POST", redirect: "error",
    signal: AbortSignal.timeout(15_000), headers: { Accept: "application/vnd.github+json", "User-Agent": "ephyra" } });
  if (!response.ok) throw new Unverified(`GitHub app creation (${response.status})`);
  const body = await response.json() as { id?: number; slug?: string; pem?: string; html_url?: string };
  if (!body.id || !body.slug || !body.pem) throw new Unverified("GitHub app creation response");
  return { appId: String(body.id), slug: body.slug, privateKey: body.pem, url: body.html_url ?? null };
}

/**
 * Check that an installation of this app can reach `repository` ("owner/name"), and return its id. The installation id
 * from a redirect is untrusted until GitHub confirms it covers the repository.
 */
export async function verifyInstallation(config: GitHubAppConfig, installationId: string, repository: string,
  fetcher: Fetch = fetch, now = Date.now()): Promise<{ installationId: string; account: string }> {
  if (!/^\d{1,15}$/.test(installationId)) throw new Unverified("GitHub installation id");
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new Unverified("GitHub repository");
  const found = await github(fetcher, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    { method: "GET", auth: `Bearer ${appJwt(config, now)}` });
  if (found.status === 404) throw new Unverified("The Ephyra GitHub app is not installed on this repository");
  if (!found.ok) throw new Unverified(`GitHub installation lookup (${found.status})`);
  const body = await found.json() as { id?: number; account?: { login?: string } };
  if (String(body.id) !== installationId) throw new Unverified("That GitHub installation does not cover this repository");
  return { installationId, account: body.account?.login ?? owner };
}

/** A one-hour token for one repository, with only the permissions landing needs. Never stored. */
export async function installationToken(config: GitHubAppConfig, installationId: string, repository: string,
  fetcher: Fetch = fetch, now = Date.now()): Promise<string> {
  const name = repository.split("/")[1];
  const response = await github(fetcher, `/app/installations/${installationId}/access_tokens`, {
    method: "POST", auth: `Bearer ${appJwt(config, now)}`,
    body: JSON.stringify({ repositories: [name], permissions: { contents: "write", pull_requests: "write", checks: "read", statuses: "read" } }),
  });
  if (!response.ok) throw new Unverified(`GitHub installation token (${response.status})`);
  const body = await response.json() as { token?: string };
  if (!body.token) throw new Unverified("GitHub installation token response");
  return body.token;
}
