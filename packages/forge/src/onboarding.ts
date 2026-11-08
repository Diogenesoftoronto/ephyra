/** Address parsing only. Network identity resolution and repository transfer belong to the application boundary. */
export type OnboardingForgeKind = "git" | "github" | "gitlab" | "forgejo" | "tangled" | "radicle";
export type ForgeRepositorySource = {
  kind: OnboardingForgeKind;
  source: string;
  repositoryId?: string;
  owner?: string;
  cloneUrl?: string;
};
export type RepositoryAddress =
  | { kind: "git" | "github" | "gitlab" | "forgejo"; source: string; cloneUrl: string }
  | { kind: "radicle"; source: string; repositoryId: string; seed?: string }
  | { kind: "tangled"; source: string; owner: string; collection: string; recordKey: string };

export class RepositoryAddressError extends Error {
  readonly code = "invalid_repository";
  constructor(message = "Enter a repository URL, Tangled AT URI, or Radicle repository ID.") {
    super(message);
    this.name = "RepositoryAddressError";
  }
}

const base58 = "[1-9A-HJ-NP-Za-km-z]";
export const isRadicleId = (value: string) => new RegExp(`^rad:z${base58}{20,60}$`).test(value);
export const isRadicleNodeId = (value: string) => new RegExp(`^z6Mk${base58}{44}$`).test(value);
export const isAtprotoHandle = (value: string) => value.length <= 253 &&
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
export function isAtprotoDid(value: string): boolean {
  return /^did:plc:[a-z2-7]{24}$/.test(value) ||
    (value.startsWith("did:web:") && isAtprotoHandle(value.slice(8)));
}
const validKey = (value: string) => value.length <= 512 && /^[a-zA-Z0-9._~:-]+$/.test(value) && ![".", ".."].includes(value);
const validSlug = (value: string) => value.length <= 100 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && !value.endsWith(".git");

export function parseRepositoryAddress(raw: string): RepositoryAddress {
  const source = raw.trim();
  if (!source || source.length > 2048 || /[\s\u0000-\u001f\u007f\\]/.test(source) || /[?#]/.test(source)) {
    throw new RepositoryAddressError("Repository addresses cannot contain credentials, queries, fragments or control characters.");
  }
  const rid = source.startsWith("rad://") ? `rad:${source.slice(6)}` : source;
  if (rid.startsWith("rad:")) {
    if (!isRadicleId(rid)) throw new RepositoryAddressError("Enter the complete Radicle repository ID (rad:z…).");
    return { kind: "radicle", source: rid, repositoryId: rid };
  }
  if (source.startsWith("at://")) {
    const match = /^at:\/\/([^/]+)\/(org\.tangled\.repo(?:\.declaration|\.manifest)?)\/([^/]+)$/.exec(source);
    if (!match || !isAtprotoDid(match[1]!) || !validKey(match[3]!) ||
      (match[2] === "org.tangled.repo.manifest" && match[3] !== "self")) {
      throw new RepositoryAddressError("Use an exact Tangled repository AT URI with its DID, collection and record key.");
    }
    return { kind: "tangled", source, owner: match[1]!, collection: match[2]!, recordKey: match[3]! };
  }
  let url: URL;
  try { url = new URL(source); } catch { throw new RepositoryAddressError(); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname === "/" || source.includes("@")) {
    throw new RepositoryAddressError("Use an HTTPS repository address without embedded credentials.");
  }
  // Reject encoded delimiters and dot segments before URL normalization can select a different namespace.
  if (/%(?:2f|5c|2e|00|0a|0d)/i.test(source) || /\/(?:\.|\.\.)(?:\/|$)/.test(source)) throw new RepositoryAddressError();
  const segments = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (segments.some((part) => !part || part.includes("%"))) throw new RepositoryAddressError();
  if (url.hostname === "app.radicle.xyz") {
    const index = segments[0] === "nodes" ? 2 : 0;
    const repositoryId = segments[index];
    if (!repositoryId || !isRadicleId(repositoryId)) throw new RepositoryAddressError("This Radicle link does not name a repository.");
    const node = index === 2 ? segments[1] : undefined;
    return { kind: "radicle", source: url.href, repositoryId, ...(node && isRadicleNodeId(node) ? { seed: node } : {}) };
  }
  if (url.hostname === "tangled.org" && !url.port) {
    if (segments.length === 1 && isAtprotoDid(segments[0]!)) {
      return { kind: "tangled", source: url.href, owner: segments[0]!, collection: "org.tangled.repo.manifest", recordKey: "self" };
    }
    const owner = segments[0]!;
    const name = segments[1]?.replace(/\.git$/, "");
    if (segments.length !== 2 || (!isAtprotoDid(owner) && !isAtprotoHandle(owner.toLowerCase())) || !name || !validSlug(name)) {
      throw new RepositoryAddressError("Use the Tangled repository page: https://tangled.org/owner/repository.");
    }
    return {
      kind: "tangled", source: url.href, owner: owner.startsWith("did:") ? owner : owner.toLowerCase(),
      collection: "org.tangled.repo.declaration", recordKey: name.toLowerCase(),
    };
  }
  const kind = url.hostname === "github.com" ? "github" : url.hostname === "gitlab.com" ? "gitlab" :
    ["codeberg.org", "git.forgejo.org"].includes(url.hostname) ? "forgejo" : "git";
  if (kind === "github" || kind === "forgejo") {
    if (segments.length !== 2) throw new RepositoryAddressError("Use the repository's home page or HTTPS clone URL.");
  } else if (kind === "gitlab" && (segments.length < 2 || segments.includes("-"))) {
    throw new RepositoryAddressError("Use the GitLab repository home page or clone URL, including its full group path.");
  }
  let path = url.pathname.replace(/\/$/, "");
  if (kind !== "git" && !path.endsWith(".git")) path += ".git";
  url.pathname = path;
  return { kind, source, cloneUrl: url.href };
}

/** Only the fixed CLI option set can be constructed; IDs and the destination remain single argv values. */
export function radicleCloneArguments(repositoryId: string, destination: string, timeoutMs: number, seeds: string[] = []): string[] {
  if (!isRadicleId(repositoryId) || !destination || /[\u0000-\u001f]/.test(destination) ||
    !Number.isFinite(timeoutMs) || timeoutMs <= 0 || seeds.some((seed) => !isRadicleNodeId(seed))) {
    throw new RepositoryAddressError("The native Radicle clone parameters are invalid.");
  }
  return ["clone", "--bare", "--no-confirm", "--timeout", `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
    ...seeds.flatMap((seed) => ["--seed", seed]), "--", repositoryId, destination];
}
