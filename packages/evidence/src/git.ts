import type { EvidenceHit, EvidenceSource } from "@ephyra/core";
import { commandRunner, type CommandRunner } from "./command.ts";

export class GitEvidence implements EvidenceSource {
  readonly name = "git";
  constructor(readonly repo: string, readonly run: CommandRunner = commandRunner) {}

  private async git(args: string[]) {
    const result = await this.run(["git", ...args], this.repo);
    if (result.code) throw new Error(`git failed: ${result.stderr}`);
    return result.stdout;
  }

  async search(q: { text: string; files?: string[]; limit: number }): Promise<EvidenceHit[]> {
    const out = await this.git(["log", `--max-count=${q.limit}`, "--format=%H%x00%s", "-S", q.text, "--", ...(q.files ?? [])]);
    return out.trim().split("\n").filter(Boolean).map(line => {
      const [revision = "", title = ""] = line.split("\0");
      return { source: this.name, id: revision, title, snippet: title, revision, score: 1 };
    });
  }

  async grep(text: string, revision = "HEAD"): Promise<string> {
    const result = await this.run(["git", "grep", "-n", "-F", "-e", text, revision], this.repo);
    if (result.code > 1) throw new Error(result.stderr);
    return result.stdout;
  }

  async recent(files: string[], limit = 10): Promise<string> {
    return this.git(["log", `--max-count=${limit}`, "--format=%H %s", "--", ...files]);
  }

  async blame(file: string, start: number, end: number, revision = "HEAD"): Promise<string> {
    return this.git(["blame", "--line-porcelain", "-L", `${start},${end}`, revision, "--", file]);
  }

  async fetch(hit: EvidenceHit) {
    return { mediaType: "text/plain", content: await this.git(["show", "--format=fuller", "--stat", hit.id, "--"]) };
  }
}
