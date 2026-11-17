import { join } from "node:path";
import type { AccountRecord } from "./account-store.ts";

const paths = ["", "assets/", "public/", "docs/", "assets/brand/", "site/assets/brand/", "public/brand/"]
  .flatMap(directory => ["svg", "png", "webp"].map(extension => `${directory}logo.${extension}`));
const maxBytes = 9_000;

async function gitLogoRead(directory: string, args: string[], limit: number) {
  const child = Bun.spawn(["git", "--no-replace-objects", "--git-dir", directory, ...args], {
    stdout: "pipe", stderr: "ignore", env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1",
    },
  });
  const timeout = setTimeout(() => child.kill(), 1000);
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { child.kill(); await reader.cancel(); return; }
      chunks.push(value);
    }
    if (await child.exited === 0) return Buffer.concat(chunks, size);
  } finally { clearTimeout(timeout); }
}

async function detectLogo(directory: string, commit: string) {
  const tree = await gitLogoRead(directory, ["ls-tree", "-z", "--full-tree", commit, "--", ...paths], 4096);
  const candidates = new Map<string, string>();
  for (const entry of tree?.toString().split("\0") ?? []) {
    const match = /^100(?:644|755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(entry);
    if (match) candidates.set(match[2]!, match[1]!);
  }
  for (const path of paths) {
    const oid = candidates.get(path);
    if (!oid) continue;
    const image = await gitLogoRead(directory, ["cat-file", "blob", oid], maxBytes);
    if (!image) continue;
    const png = path.endsWith(".png") && image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    const webp = path.endsWith(".webp") && image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP";
    const svg = path.endsWith(".svg") && /<svg[\s>]/.test(image.toString("utf8"));
    const type = png ? "png" : webp ? "webp" : svg ? "svg+xml" : undefined;
    // Inline images render only inside an <img>, which disables SVG scripting and external resources.
    if (type) return `data:image/${type};base64,${image.toString("base64")}`;
  }
}

export function repositoryLogoDetector(workspaceDirectory: (workspace: string) => string) {
  const cache = new Map<string, { expires: number; image: Promise<string | undefined> }>();
  return (record: AccountRecord) => {
    const { repository, workspaceId } = record.settings;
    if (!repository || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(repository.head)) return Promise.resolve(undefined);
    const key = `${workspaceId}:${repository.head}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expires > now) return cached.image;
    const image = detectLogo(join(workspaceDirectory(workspaceId), "workspace.git"), repository.head).catch(() => undefined);
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: now + 60_000, image });
    return image;
  };
}
