import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Files are addressed by their SHA-256 content digest. */
export class ArtifactStore {
  constructor(private readonly root: string) {}

  async put(content: Uint8Array): Promise<{ digest: string; bytes: number }> {
    const hash = createHash("sha256").update(content).digest("hex");
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, hash), content, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return { digest: `sha256:${hash}`, bytes: content.byteLength };
  }

  async get(digest: string): Promise<Uint8Array> {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new TypeError("invalid digest");
    const content = await readFile(join(this.root, digest.slice(7)));
    if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== digest) {
      throw new Error("artifact digest mismatch");
    }
    return content;
  }
}
