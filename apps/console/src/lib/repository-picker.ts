export type RepositorySource = "github" | "gitlab" | "tangled" | "forgejo" | "git";
export const REPOSITORY_SOURCES = [
  { id: "github", name: "GitHub", home: "https://github.com/dashboard", placeholder: "https://github.com/team/project" },
  { id: "gitlab", name: "GitLab", home: "https://gitlab.com/dashboard/projects", placeholder: "https://gitlab.com/team/project" },
  { id: "tangled", name: "Tangled", home: "https://tangled.org", placeholder: "https://tangled.org/handle.example/project" },
  { id: "forgejo", name: "Forgejo", home: "https://codeberg.org", placeholder: "https://codeberg.org/team/project" },
  { id: "git", name: "Other Git / Radicle", home: "https://app.radicle.xyz", placeholder: "https://git.example.org/team/project.git or rad:z…" },
] as const;

export function detectRepositorySource(value: string): RepositorySource | undefined {
  if (/^rad:/.test(value)) return "git";
  if (/^at:\/\//.test(value)) return "tangled";
  try {
    const host = new URL(value).hostname;
    if (host === "github.com") return "github";
    if (host === "gitlab.com") return "gitlab";
    if (host === "tangled.org" || host === "tangled.sh") return "tangled";
    if (host === "codeberg.org") return "forgejo";
  } catch { /* Incomplete input stays with the chosen source. */ }
  return undefined;
}

export interface RepositoryChoice { name: string; url: string; branch: string; description: string }
/** Public discovery only. Credentials and private access stay in the server's existing connection flow. */
export async function listGitHubRepositories(owner: string, page: number, signal: AbortSignal, request: typeof fetch = fetch): Promise<RepositoryChoice[]> {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) throw new Error("Enter a GitHub username or organization name, such as octocat.");
  const response = await request(`https://api.github.com/users/${encodeURIComponent(owner)}/repos?sort=updated&per_page=30&page=${page}`, {
    signal, credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(response.status === 404 ? "That GitHub account was not found. Check the name or paste a repository link below."
    : response.status === 403 || response.status === 429 ? "GitHub’s public lookup limit was reached. Paste a repository link below."
    : "GitHub could not be reached. Try again or paste a repository link below.");
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error("GitHub returned an unreadable list. Paste a repository link below.");
  return rows.flatMap((row): RepositoryChoice[] => {
    if (!row || typeof row !== "object" || typeof row.full_name !== "string" || row.private === true) return [];
    const [account, name, extra] = row.full_name.split("/");
    if (extra || account.toLowerCase() !== owner.toLowerCase() || !/^[\w.-]+$/.test(name)) return [];
    return [{ name: row.full_name, url: `https://github.com/${account}/${name}.git`,
      branch: typeof row.default_branch === "string" ? row.default_branch : "",
      description: typeof row.description === "string" ? row.description : "" }];
  });
}
