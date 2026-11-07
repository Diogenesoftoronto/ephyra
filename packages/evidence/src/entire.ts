import { Unverified, type EvidenceHit, type EvidenceSource } from "@ephyra/core";
import { commandRunner, type CommandRunner } from "./command.ts";

/** An unavailable local installation, repository, or search service is not an empty result. */
export class Unavailable extends Unverified {
  constructor(feature: string) { super(feature); this.name = "Unavailable"; }
}

export function filterToCheckpoints(hits: EvidenceHit[], recordedIds: readonly string[]): EvidenceHit[] {
  const ids = new Set(recordedIds);
  return hits.filter(hit => ids.has(hit.id));
}

function parseJson(stdout: string): EvidenceHit[] {
  const data: unknown = JSON.parse(stdout);
  const rows = Array.isArray(data) ? data : (data as { results?: unknown[] })?.results;
  if (!Array.isArray(rows)) throw new Unverified("entire search output format");
  return rows.flatMap((row): EvidenceHit[] => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || item.type !== "checkpoint") return [];
    return [{ source: "entire", id: item.id, title: String(item.title ?? ""),
      snippet: String(item.snippet ?? ""), score: typeof item.score === "number" ? item.score : 0 }];
  });
}

/** Text fallback accepts tabular rows with a full checkpoint id, never inventing ids. */
function parseText(stdout: string): EvidenceHit[] {
  const hits: EvidenceHit[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/\b([0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})\b/);
    if (match) hits.push({ source: "entire", id: match[1]!, title: line.trim(), snippet: line.trim(), score: 0 });
  }
  if (!hits.length && stdout.trim() && !/no (results|matches|checkpoints)/i.test(stdout)) {
    throw new Unverified("entire search text format");
  }
  return hits;
}

export class EntireEvidence implements EvidenceSource {
  readonly name = "entire";
  constructor(readonly repo: string, readonly recordedIds: readonly string[], readonly run: CommandRunner = commandRunner) {}

  async search(q: { text: string; limit: number }): Promise<EvidenceHit[]> {
    let result: Awaited<ReturnType<CommandRunner>>;
    try {
      result = await this.run(["entire", "search", q.text, "--json", "--compact", "--limit", String(q.limit)], this.repo);
      if (result.code && /unknown flag.*(--json|--compact)/i.test(result.stderr)) {
        result = await this.run(["entire", "search", q.text, "--limit", String(q.limit)], this.repo);
        if (result.code) throw new Unavailable("entire search");
        return filterToCheckpoints(parseText(result.stdout), this.recordedIds);
      }
    } catch (error) {
      if (error instanceof Unverified) throw error;
      throw new Unavailable("entire search");
    }
    if (result.code) throw new Unavailable("entire search unavailable or repository not enabled");
    let hits: EvidenceHit[];
    try { hits = parseJson(result.stdout); } catch (error) {
      if (error instanceof SyntaxError) throw new Unverified("entire search output format");
      throw error;
    }
    return filterToCheckpoints(hits, this.recordedIds);
  }

  async fetch(hit: EvidenceHit) {
    if (!this.recordedIds.includes(hit.id)) throw new Unverified("unrecorded checkpoint");
    let result: Awaited<ReturnType<CommandRunner>>;
    try { result = await this.run(["entire", "checkpoint", "explain", hit.id], this.repo); }
    catch { throw new Unavailable("entire checkpoint explain"); }
    if (result.code) throw new Unavailable("entire checkpoint explain");
    return { mediaType: "text/plain", content: result.stdout };
  }
}
