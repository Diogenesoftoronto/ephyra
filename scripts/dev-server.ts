import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Local development only. Production continues to require explicit configuration.
const root = resolve(import.meta.dir, "..");
const dataDir = process.env.EPHYRA_DATA_DIR ?? resolve(root, ".ephyra-local");
let token = process.env.EPHYRA_API_TOKEN;
if (token === undefined) {
  const credentialDir = resolve(root, ".ephyra-local");
  await mkdir(credentialDir, { recursive: true, mode: 0o700 });
  const credentialPath = resolve(credentialDir, "dev-api-token");
  try {
    const file = await open(credentialPath, "wx", 0o600);
    try { await file.writeFile(crypto.randomUUID() + crypto.randomUUID()); }
    finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  token = (await readFile(credentialPath, "utf8")).trim();
}
if (token.length < 16) {
  console.error("Local API requires EPHYRA_API_TOKEN with at least 16 characters. Check your environment or .env.");
  process.exit(2);
}
const child = Bun.spawn([process.execPath, "run", "apps/server/src/main.ts"], {
  cwd: root,
  env: { ...process.env, EPHYRA_API_TOKEN: token, EPHYRA_DATA_DIR: dataDir },
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
