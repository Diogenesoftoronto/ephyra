import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleStatic, hasConsole } from "./http/static.ts";
import { compose } from "./compose.ts";
import { readConfig } from "./config.ts";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ephyra-static-"));
  await mkdir(join(dir, "console", "assets"), { recursive: true });
  await writeFile(join(dir, "console", "index.html"), "<!doctype html><title>Ephyra</title>");
  await writeFile(join(dir, "console", "assets", "app-abc.js"), "console.log(1)");
  await writeFile(join(dir, "secret.txt"), "top secret");
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("console static serving", () => {
  test("serves files, falls back to index.html for client routes, redirects /app, and never leaves the directory", async () => {
    const app = consoleStatic(join(dir, "console"));
    expect(hasConsole(join(dir, "console"))).toBe(true);
    expect(hasConsole(join(dir, "nope"))).toBe(false);
    const js = await app.request("/app/assets/app-abc.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await js.text()).toBe("console.log(1)");
    for (const route of ["/app/", "/app/runs", "/app/workspace/autonomy.md"]) {
      const res = await app.request(route);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Ephyra</title>");
    }
    expect((await app.request("/app/missing.js")).status).toBe(404);
    const redirect = await app.request("/app");
    expect(redirect.status).toBe(301);
    for (const sneaky of ["/app/../secret.txt", "/app/%2e%2e/secret.txt", "/app/..%2fsecret.txt", "/app/%2e%2e%2fsecret.txt"]) {
      const res = await app.request(sneaky);
      expect(await res.text()).not.toContain("top secret");
    }
  });
  test("compose mounts /app/ only when the directory exists, and /v1 still needs auth", async () => {
    const base = { EPHYRA_API_TOKEN: "t".repeat(32), EPHYRA_DATA_DIR: join(dir, "data") };
    const without = await compose(readConfig({ ...base, EPHYRA_CONSOLE_DIR: join(dir, "absent") }), { startJobs: false });
    expect((await without.app.request("/app/")).status).toBe(404);
    const withDir = await compose(readConfig({ ...base, EPHYRA_CONSOLE_DIR: join(dir, "console") }), { startJobs: false });
    expect((await withDir.app.request("/app/")).status).toBe(200);
    expect((await withDir.app.request("/app/runs")).status).toBe(200);
    expect((await withDir.app.request("/v1/runs")).status).toBe(401);
    expect((await withDir.app.request("/healthz")).status).toBe(200);
    await without.close(); await withDir.close();
  });
});
