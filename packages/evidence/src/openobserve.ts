import { Unverified, type EvidenceHit, type EvidenceSource } from "@ephyra/core";

/** OpenObserve search API: https://openobserve.ai/docs/reference/api/search/search/ */
export class OpenObserveEvidence implements EvidenceSource {
  readonly name = "otel";
  constructor(
    readonly options: { url: string; org: string; stream: string; authorization: string; from: Date; to: Date },
    readonly request: typeof fetch = fetch,
  ) {}
  async search(query: { text: string; fingerprint?: string; limit: number }): Promise<EvidenceHit[]> {
    const field = query.fingerprint ? "fingerprint" : "trace_id";
    const value = (query.fingerprint ?? query.text).replaceAll("'", "''");
    const stream = this.options.stream.replaceAll('"', '""');
    const sql = `SELECT * FROM "${stream}" WHERE "${field}" = '${value}'`;
    const response = await this.request(`${this.options.url.replace(/\/$/, "")}/api/${encodeURIComponent(this.options.org)}/_search`, {
      method: "POST",
      headers: { authorization: this.options.authorization, "content-type": "application/json" },
      body: JSON.stringify({ query: { sql, start_time: this.options.from.getTime() * 1000,
        end_time: this.options.to.getTime() * 1000, from: 0, size: query.limit } }),
    });
    if (!response.ok) throw new Unverified("OpenObserve search");
    const data = await response.json() as { hits?: unknown[]; is_partial?: boolean };
    if (!Array.isArray(data.hits) || data.is_partial) throw new Unverified("OpenObserve incomplete search");
    return data.hits.map((row, index) => ({ source: this.name, id: String(index), title: "Telemetry record",
      snippet: JSON.stringify(row), score: 1 }));
  }
  async fetch(hit: EvidenceHit) { return { mediaType: "application/json", content: hit.snippet }; }
}
