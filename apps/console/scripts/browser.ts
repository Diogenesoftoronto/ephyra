// Shared by the smoke render and the screenshot script: a static file server and the headless browser.
// Run with `env -u LD_LIBRARY_PATH` (the nix LD_LIBRARY_PATH breaks chrome-headless-shell).
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser } from "playwright";

export const HEADLESS_SHELL = join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell");

export async function launch(): Promise<Browser> {
  if (!existsSync(HEADLESS_SHELL)) throw new Error(`chrome-headless-shell not found at ${HEADLESS_SHELL}`);
  return chromium.launch({ executablePath: HEADLESS_SHELL, headless: true });
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".webp": "image/webp", ".png": "image/png", ".ico": "image/x-icon",
  ".map": "application/json",
};

/** Serve a built directory. `mount` is a URL prefix to strip (the app is built for /app/). Missing files answer 404. */
export function serve(root: string, mount = ""): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (mount && path.startsWith(mount)) path = path.slice(mount.length - 1);
      if (path.endsWith("/")) path += "index.html";
      const file = normalize(join(root, path));
      if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file), { headers: { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}
