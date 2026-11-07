import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./cas.ts";

test("CAS addresses bytes by digest and detects tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "ephyra-cas-"));
  try {
    const store = new ArtifactStore(root);
    const bytes = new TextEncoder().encode("hello");
    const ref = await store.put(bytes);
    expect(ref.digest).toBe("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(await store.put(bytes)).toEqual(ref);
    expect(await store.get(ref.digest)).toEqual(bytes);
    await writeFile(join(root, ref.digest.slice(7)), "changed");
    await expect(store.get(ref.digest)).rejects.toThrow("digest mismatch");
    await expect(store.get("../outside")).rejects.toThrow("invalid digest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
