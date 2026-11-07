export const PAGES = ["overview", "inbox", "runs", "usage", "workspace", "personas"] as const;
export type PageId = (typeof PAGES)[number];
export type Route = { page: PageId; id?: string } | { page: "not-found"; path: string };

/** `#/inbox/<trail id>` to `{ page: "inbox", id }`. An empty hash is the overview; an unknown one is not-found. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").split("?")[0]!;
  if (path === "") return { page: "overview" };
  const [page, id, ...rest] = path.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (!PAGES.includes(page as PageId) || rest.length > 0)
    return { page: "not-found", path: path.slice(0, 80) };
  return id ? { page: page as PageId, id } : { page: page as PageId };
}

export const hrefFor = (page: PageId): string => `#/${page}`;
