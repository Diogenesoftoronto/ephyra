import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const run = (args: string[], cwd: string) => Bun.spawnSync(args, {cwd, stdout: "pipe", stderr: "pipe"});
export async function init(cwd: string, remote = "origin", force = false) {
  if (remote.startsWith("-") || !remote) throw new Error("Invalid remote");
  if (run(["git", "remote", "get-url", remote], cwd).exitCode !== 0) throw new Error("Git remote not found");
  await mkdir(join(cwd,"ephyra"), {recursive:true});
  const result: string[] = [];
  for (const name of ["autonomy.md", "thresholds.yaml", "models.yaml"]) {
    try { await writeFile(join(cwd,"ephyra",name), await readFile(new URL(`../templates/${name}`, import.meta.url)), {flag: force ? "w" : "wx"}); result.push(name); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  for (const kind of ["fetch", "push"]) {
    const key = `remote.${remote}.${kind}`, spec = "+refs/ephyra/*:refs/ephyra/*";
    const existing = run(["git","config","--get-all",key],cwd).stdout.toString().trim().split("\n");
    if (!existing.includes(spec) && run(["git","config","--add",key,spec],cwd).exitCode !== 0) throw new Error("Could not configure git refspec");
  }
  return result;
}
