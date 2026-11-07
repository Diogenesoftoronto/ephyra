import type { EvidenceHit, EvidenceSource, Journal } from "@ephyra/core";

/** Indexes journal records; fingerprints and files are supplied by an injected resolver. */
export class TrailsEvidence implements EvidenceSource {
  readonly name = "trails";
  constructor(readonly journal: Journal, readonly context: (id: string) => Promise<{ files: string[]; fingerprints: string[] }>) {}
  async search(query: { text: string; files?: string[]; fingerprint?: string; limit: number }): Promise<EvidenceHit[]> {
    const hits: EvidenceHit[] = [];
    for (const id of await this.journal.list()) {
      const record = await this.journal.read(id);
      if (!record) continue;
      const context = await this.context(id);
      const shared = (query.files ?? []).filter(file => context.files.includes(file)).length;
      const fingerprint = query.fingerprint && context.fingerprints.includes(query.fingerprint) ? 1 : 0;
      const text = record.trail.title.toLowerCase().includes(query.text.toLowerCase()) ? 1 : 0;
      if (!shared && !fingerprint && !text) continue;
      hits.push({ source: this.name, id, title: record.trail.title, snippet: record.trail.updatedAt,
        revision: record.head, score: shared + fingerprint * 2 + text });
    }
    return hits.sort((a, b) => b.score - a.score || b.snippet.localeCompare(a.snippet)).slice(0, query.limit);
  }
  async fetch(hit: EvidenceHit) {
    const record = await this.journal.read(hit.id);
    if (!record) throw new Error("Trail not found");
    return { mediaType: "application/json", content: JSON.stringify(record) };
  }
}
