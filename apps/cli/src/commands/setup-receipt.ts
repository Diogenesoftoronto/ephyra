import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { credentialsPath } from "../login";

export type SetupPending = {
  key: string; workspace: string;
} & ({ kind: "setup" } | { kind: "repository"; version: number; url: string; branch: string | null });
export interface SetupReceipts {
  read(): Promise<SetupPending | null>;
  claim(value: SetupPending): Promise<void>;
  clear(key: string): Promise<void>;
}

function receipt(value: unknown): SetupPending {
  const v = value as Partial<SetupPending>;
  if (!v || typeof v.key !== "string" || !/^setup:[a-f0-9-]{36}$/.test(v.key) || typeof v.workspace !== "string")
    throw new Error("Invalid setup receipt");
  if (v.kind === "setup") return { kind: v.kind, key: v.key, workspace: v.workspace };
  if (v.kind === "repository" && Number.isSafeInteger(v.version) && v.version! >= 0 && typeof v.url === "string"
    && (v.branch === null || typeof v.branch === "string")) {
    const url = new URL(v.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid repository receipt");
    return { kind: v.kind, key: v.key, workspace: v.workspace, version: v.version!, url: v.url, branch: v.branch };
  }
  throw new Error("Invalid setup receipt");
}

/** One credential-free, private receipt per origin/account. Exclusive creation also guards two CLI processes. */
export function setupReceipts(origin: string, did: string, env: Record<string, string | undefined> = process.env): SetupReceipts {
  const id = createHash("sha256").update(JSON.stringify([origin, did])).digest("hex").slice(0, 32);
  const path = join(dirname(credentialsPath(env)), `setup-${id}.json`);
  const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { await mkdir(`${path}.lock`, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`Setup receipt is busy at ${path}.lock. Let the other CLI finish; if it stopped, ask the operator to reconcile the lock.`);
      throw error;
    }
    try { return await work(); }
    finally { await rmdir(`${path}.lock`); }
  };
  const read = async (): Promise<SetupPending | null> => {
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      return receipt(JSON.parse(raw));
    } catch { throw new Error(`Setup has an unreadable pending receipt at ${path}. Keep it for the operator to reconcile before another write.`); }
  };
  return {
    read: () => locked(read),
    claim: value => locked(async () => {
      const safe = receipt(value);
      try { await writeFile(path, JSON.stringify(safe) + "\n", { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("Another setup change is pending. Resume the wizard to check its saved result first.");
        throw error;
      }
      await chmod(path, 0o600);
    }),
    clear: key => locked(async () => {
      if ((await read())?.key === key) await unlink(path);
    }),
  };
}
