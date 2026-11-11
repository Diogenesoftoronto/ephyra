import { existsSync } from "node:fs";
import { resolve } from "node:path";
const name = process.argv[2]?.replace(/^@ephyra\//, "");
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("Usage: bun run check:package <package or app name>");
  process.exit(2);
}
const roots = ["packages", "apps"].map(root => `${root}/${name}`).filter(path => existsSync(resolve(import.meta.dir, "..", path, "package.json")));
if (roots.length !== 1) {
  console.error(`Unknown or ambiguous workspace: ${name}`);
  process.exit(2);
}
process.chdir(resolve(import.meta.dir, ".."));
for (const args of [["bun", "run", "--filter", `@ephyra/${name}`, "typecheck"], ["bun", "test", `./${roots[0]}`]]) {
  const code = await Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
  if (code) process.exit(code);
}
