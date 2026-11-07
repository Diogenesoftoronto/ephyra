import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("every console component and screen has stories with an actual render", () => {
  const missing: string[] = [];
  for (const dir of ["components", "pages", "assistant", "genui", "voice"]) {
    const path = join(import.meta.dir, "..", dir);
    for (const file of readdirSync(path).filter(
      (f) => f.endsWith(".tsx") && !f.includes(".stories.") && f !== "registry.tsx",
    )) {
      const story = join(path, file.replace(/\.tsx$/, ".stories.tsx"));
      if (!existsSync(story) || !/export const/.test(readFileSync(story, "utf8")))
        missing.push(`${dir}/${file}`);
    }
  }
  expect(missing).toEqual([]);
});
