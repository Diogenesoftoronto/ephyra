import { run, must } from "./git.ts";
export async function configureRefspecs(repoDir: string, remote: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(remote)) throw new Error("invalid remote");
  for (const [kind, spec] of [
    ["fetch", "+refs/ephyra/*:refs/ephyra/*"],
    ["push", "refs/ephyra/*:refs/ephyra/*"],
  ] as const) {
    const key = `remote.${remote}.${kind}`;
    const x = await run(["config", "--get-all", key], { cwd: repoDir });
    if (!x.text.split("\n").includes(spec))
      await must(["config", "--add", key, spec], { cwd: repoDir });
  }
}
