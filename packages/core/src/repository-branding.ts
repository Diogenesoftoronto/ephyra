import { z } from "zod";

export const MAX_REPOSITORY_LOGOS = 24;
// The console resizes uploads before saving. Accept only bounded inline raster URLs.
export const RepositoryLogo = z.string().max(13_000)
  .regex(/^data:image\/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAw[A-Za-z0-9+/]+={0,2}$/);
export const RepositoryLogos = z.record(z.string().max(2064), RepositoryLogo)
  .refine(logos => Object.keys(logos).length <= MAX_REPOSITORY_LOGOS);
export type RepositoryLogos = z.infer<typeof RepositoryLogos>;
export const RepositoryLogoUpdate = z.object({
  expectedVersion: z.number().int().nonnegative(),
  address: z.string().trim().min(1).max(2048),
  scope: z.enum(["repository", "organization"]),
  image: RepositoryLogo.nullable(),
}).strict();
export type RepositoryLogoUpdate = z.infer<typeof RepositoryLogoUpdate>;

export function repositoryBranding(address: string) {
  const raw = address.trim();
  if (/^rad:z[A-Za-z0-9]+$/.test(raw)) return { repository: `repo:${raw}` };
  const at = /^at:\/\/(did:[a-z0-9]+:[\w.:%-]+)\/org\.tangled\.repo\/([\w.-]+)$/.exec(raw);
  if (at) return { repository: `repo:${raw}`, organization: `org:tangled:${at[1]}` };
  const url = URL.parse(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return {};
  if (url.host === "app.radicle.xyz") {
    const id = url.pathname.split("/").find(part => /^rad:z[A-Za-z0-9]+$/.test(part));
    if (id) return { repository: `repo:${id}` };
  }
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!path) return {};
  const canonical = url.host === "github.com" ? path.toLowerCase() : path;
  const parts = canonical.split("/");
  const host = url.host === "tangled.sh" ? "tangled.org" : url.host;
  const github = host === "github.com" && parts.length === 2
    && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(parts[0]!) && /^[a-z0-9_.-]+$/.test(parts[1]!)
    ? `${parts[0]}/${parts[1]}` : undefined;
  if (host === "github.com" && !github) return {};
  return { repository: `repo:${host}/${canonical}`,
    organization: parts.length > 1 ? `org:${host}/${parts.slice(0, -1).join("/")}` : undefined, github };
}

export function repositoryLogoSources(address: string, logos?: RepositoryLogos, canonicalAddress?: string, detected?: string): string[] {
  const identity = repositoryBranding(address);
  const canonical = canonicalAddress ? repositoryBranding(canonicalAddress) : identity;
  const keys = (scope: "repository" | "organization") => [identity[scope], canonical[scope]];
  const saved = (scope: "repository" | "organization") => keys(scope).flatMap(key => key && logos?.[key] ? [logos[key]] : []);
  const github = identity.github ?? canonical.github;
  const logosInGit = detected ? [detected] : github ? ["logo.svg", "logo.png", "assets/logo.svg", "assets/logo.png"].map(path =>
    `https://raw.githubusercontent.com/${github}/HEAD/${path}`) : [];
  const avatar = github ? [`https://github.com/${github.split("/")[0]}.png?size=64`] : [];
  return [...new Set([...saved("repository"), ...logosInGit, ...saved("organization"), ...avatar])];
}
