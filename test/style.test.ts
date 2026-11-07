// Guardrail: readable source. Dense one-line functions hide bugs from reviewers.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MAX = 160;
function walk(dir: string): string[] {
  let out: string[] = [];
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "fixtures" || n === "templates") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}
test(`source lines are at most ${MAX} characters (fixtures and templates exempt)`, () => {
  const long: string[] = [];
  for (const base of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, base))) {
      const src = join(ROOT, base, pkg, "src");
      try { statSync(src); } catch { continue; }
      for (const f of walk(src)) {
        readFileSync(f, "utf8").split("\n").forEach((line, i) => {
          if (line.length > MAX && !/https?:\/\/|^\s*(\/\/|\*)/.test(line)) long.push(`${f.replace(ROOT + "/", "")}:${i + 1} (${line.length})`);
        });
      }
    }
  }
  expect(long).toEqual([]);
});
