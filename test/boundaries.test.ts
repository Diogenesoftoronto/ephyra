// Guardrail: package dependency boundaries from AGENTS.md. Fails on any import that crosses them.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ADAPTERS = ["policy", "journal", "ingest", "models", "forge", "runner", "agent", "evidence"];
const allowed: Record<string, string[]> = {
  "packages/core": [],
  ...Object.fromEntries(ADAPTERS.map((p) => [`packages/${p}`, ["core"]])),
  "packages/genui": ["core"],
  "apps/cli": ["core", "policy"],
  "apps/console": ["core", "genui"],
  "apps/web": [],
  "apps/server": ["core", ...ADAPTERS, "genui"],
  "apps/evals": ["core", ...ADAPTERS],
};

function files(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("workspace boundaries", () => {
  for (const [pkg, ok] of Object.entries(allowed)) {
    test(`${pkg} imports only ${ok.length ? ok.join(", ") : "nothing internal"}`, () => {
      const bad: string[] = [];
      for (const f of files(join(ROOT, pkg, "src"))) {
        const src = readFileSync(f, "utf8");
        for (const m of src.matchAll(/from\s+["']@ephyra\/([a-z-]+)["']|import\(\s*["']@ephyra\/([a-z-]+)["']\s*\)/g)) {
          const dep = m[1] ?? m[2]!;
          if (!ok.includes(dep)) bad.push(`${f.replace(ROOT + "/", "")} → @ephyra/${dep}`);
        }
        if (/from\s+["']\.\.\/\.\.\/(packages|apps)\//.test(src)) bad.push(`${f.replace(ROOT + "/", "")} → relative cross-package import`);
      }
      expect(bad).toEqual([]);
    });
  }
  test("core has no I/O imports", () => {
    const bad: string[] = [];
    for (const f of files(join(ROOT, "packages/core/src"))) {
      const src = readFileSync(f, "utf8");
      if (/from\s+["'](node:|bun|fs|child_process|net|http)/.test(src)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});
