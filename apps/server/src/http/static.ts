// Serves the built web console (apps/console) at /app/ with SPA fallback. Mounted only when the directory exists.
import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { Hono } from "hono";

export const hasConsole = (dir: string): boolean => existsSync(join(dir, "index.html"));

export function consoleStatic(dir: string): Hono {
  const root = normalize(dir.endsWith(sep) ? dir : dir + sep);
  const app = new Hono();
  const serve = async (path: string, cache: string) => {
    const file = Bun.file(path);
    return new Response(file, { headers: { "content-type": file.type, "cache-control": cache, "x-content-type-options": "nosniff" } });
  };
  app.get("/app", (c) => c.redirect("/app/", 301));
  app.get("/app/*", async (c) => {
    let rel: string;
    try { rel = decodeURIComponent(new URL(c.req.url).pathname.slice("/app/".length)); } catch { return c.text("bad request", 400); }
    const target = normalize(join(root, rel));
    // Never leave the console directory; a path that is not a file is a client-side route.
    if (rel && target.startsWith(root) && existsSync(target) && statSync(target).isFile()) {
      return serve(target, rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    }
    if (/\.[A-Za-z0-9]{1,8}$/.test(rel)) return c.text("not found", 404);
    return serve(join(root, "index.html"), "no-cache");
  });
  return app;
}
