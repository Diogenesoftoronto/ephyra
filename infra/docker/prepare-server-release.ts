import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Export committed source only. In-progress files, credentials, local dependencies and generated media are excluded.
async function command(args: string[]): Promise<string> {
  const process = Bun.spawn(args, { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exit !== 0) throw new Error(`${args[0]} failed: ${error.slice(0, 500)}`);
  return out.trim();
}
const revision = await command(["git", "rev-parse", "HEAD"]);
if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)) throw new Error("Expected exact Git revision");
const directory = await mkdtemp(join(tmpdir(), "ephyra-server-release-"));
const archive = join(directory, "source.tar");
const source = join(directory, "source");
await command(["git", "archive", "--format=tar", `--output=${archive}`, revision]);
await command(["mkdir", "-p", source]);
await command(["tar", "-xf", archive, "-C", source]);
await writeFile(join(source, "ephyra-release.json"), JSON.stringify({ schema: 1, revision }) + "\n");
const archiveSha256 = createHash("sha256").update(Buffer.from(await Bun.file(archive).arrayBuffer())).digest("hex");
await writeFile(join(directory, "release.json"), JSON.stringify({ schema: 1, revision, archiveSha256, source }, null, 2) + "\n");
console.log(JSON.stringify({ revision, archiveSha256, source, manifest: join(directory, "release.json") }));
