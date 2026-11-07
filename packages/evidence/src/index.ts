import type { Clock, SignalStore, WatchConfig, WatchObservations } from "@ephyra/core";

export type WatchState = { probeFailures: Record<string, number>; aboveSince: string | null };
export type WatchDeps = { signals: SignalStore; runProbe(id: string): Promise<"pass" | "fail" | "unavailable">; clock: Clock; state?: WatchState; errorRateMultiplier?: number };

/** Collect measurements; policy owns the decision to roll back. State must be persisted by the caller. */
export class WatchCollector {
  async collect(config: WatchConfig, deps: WatchDeps): Promise<{ observations: WatchObservations; state: WatchState }> {
    const now = deps.clock.now(), start = new Date(config.startedAt);
    const gaps: string[] = [];
    const state: WatchState = { probeFailures: { ...deps.state?.probeFailures }, aboveSince: deps.state?.aboveSince ?? null };
    let recurrences = 0;
    for (const fingerprint of new Set(config.fingerprints)) {
      try { recurrences += await deps.signals.countSince(fingerprint, start); } catch { gaps.push(`fingerprint:${fingerprint}`); }
    }
    let newFingerprints: string[] = [];
    try { newFingerprints = [...new Set((await deps.signals.newFingerprintsInFiles(config.touchedFiles, start)).map(s => s.fingerprint))]; } catch { gaps.push("new fingerprints"); }
    for (const id of new Set(config.areaProbes)) {
      let result: "pass" | "fail" | "unavailable" = "unavailable";
      try { result = await deps.runProbe(id); } catch { /* unavailable */ }
      if (result === "unavailable") gaps.push(`probe:${id}`);
      else state.probeFailures[id] = result === "pass" ? 0 : (state.probeFailures[id] ?? 0) + 1;
    }
    let errorRate: WatchObservations["errorRate"] = null;
    if (config.routes.length) {
      let errors = 0, requests = 0, complete = true;
      for (const route of new Set(config.routes)) {
        try {
          const rate = await deps.signals.errorRate(route, start, now);
          if (!rate || rate.requests <= 0) { complete = false; gaps.push(`error rate:${route}`); }
          else { errors += rate.errors; requests += rate.requests; }
        } catch { complete = false; gaps.push(`error rate:${route}`); }
      }
      if (complete && requests > 0) {
        const current = errors / requests;
        if (current > config.baseline.errorRate * (deps.errorRateMultiplier ?? 2)) state.aboveSince ??= now.toISOString();
        else state.aboveSince = null;
        errorRate = { current, baseline: config.baseline.errorRate, sustainedAboveS: state.aboveSince ? Math.max(0, (now.getTime() - Date.parse(state.aboveSince)) / 1000) : 0 };
      } else state.aboveSince = null;
    } else { gaps.push("error rate:no routes"); state.aboveSince = null; }
    gaps.push("tracer clusters: unavailable");
    return { observations: { elapsedS: Math.max(0, (now.getTime() - start.getTime()) / 1000), fingerprintRecurrences: recurrences, newFingerprintsInTouchedFiles: newFingerprints, probeConsecutiveFailures: { ...state.probeFailures }, errorRate, tracerNewClusters: 0, coverageGaps: gaps }, state };
  }
}

import type { EvidenceHit, EvidenceSource } from "@ephyra/core";
import { Unverified } from "@ephyra/core";
export type CommandRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export const commandRunner: CommandRunner = async (args, cwd) => {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};
export class GitEvidence implements EvidenceSource {
  readonly name = "git";
  constructor(readonly repo: string, readonly run: CommandRunner = commandRunner) {}
  private async git(args: string[]) { const r = await this.run(["git", ...args], this.repo); if (r.code) throw new Error(`git failed: ${r.stderr}`); return r.stdout; }
  async search(q: { text: string; files?: string[]; limit: number }): Promise<EvidenceHit[]> {
    const out = await this.git(["log", `--max-count=${q.limit}`, "--format=%H%x00%s", "-S", q.text, "--", ...(q.files ?? [])]);
    return out.trim().split("\n").filter(Boolean).map(line => { const [revision = "", title = ""] = line.split("\0"); return { source: this.name, id: revision, title, snippet: title, revision, score: 1 }; });
  }
  async grep(text: string, revision = "HEAD"): Promise<string> { const r = await this.run(["git", "grep", "-n", "-F", "-e", text, revision], this.repo); if (r.code > 1) throw new Error(r.stderr); return r.stdout; }
  async recent(files: string[], limit = 10): Promise<string> { return this.git(["log", `--max-count=${limit}`, "--format=%H %s", "--", ...files]); }
  async blame(file: string, start: number, end: number, revision = "HEAD"): Promise<string> { return this.git(["blame", "--line-porcelain", "-L", `${start},${end}`, revision, "--", file]); }
  async fetch(hit: EvidenceHit) { return { mediaType: "text/plain", content: await this.git(["show", "--format=fuller", "--stat", hit.id, "--"]) }; }
}
export function filterToCheckpoints(hits: EvidenceHit[], recordedIds: readonly string[]): EvidenceHit[] { const ids = new Set(recordedIds); return hits.filter(h => ids.has(h.id)); }
export class EntireEvidence implements EvidenceSource {
  readonly name = "entire";
  constructor(readonly repo: string, readonly recordedIds: readonly string[], readonly run: CommandRunner = commandRunner) {}
  async search(q: { text: string; limit: number }): Promise<EvidenceHit[]> {
    let r: Awaited<ReturnType<CommandRunner>>;
    try { r = await this.run(["entire", "search", q.text, "--json", "--compact", "--limit", String(q.limit)], this.repo); } catch { throw new Unverified("entire search unavailable"); }
    if (r.code) throw new Unverified("entire search unavailable or repository not enabled");
    let data: unknown; try { data = JSON.parse(r.stdout); } catch { throw new Unverified("entire search output format"); }
    const rows = Array.isArray(data) ? data : (data as { results?: unknown[] })?.results;
    if (!Array.isArray(rows)) throw new Unverified("entire search output format");
    const hits = rows.flatMap((row): EvidenceHit[] => { if (!row || typeof row !== "object") return []; const x = row as Record<string, unknown>; if (typeof x.id !== "string" || x.type !== "checkpoint") return []; return [{ source: this.name, id: x.id, title: String(x.title ?? ""), snippet: String(x.snippet ?? ""), score: typeof x.score === "number" ? x.score : 0 }]; });
    return filterToCheckpoints(hits, this.recordedIds);
  }
  async fetch(hit: EvidenceHit) { if (!this.recordedIds.includes(hit.id)) throw new Unverified("unrecorded checkpoint"); const r = await this.run(["entire", "checkpoint", "explain", hit.id], this.repo); if (r.code) throw new Unverified("entire checkpoint explain"); return { mediaType: "text/plain", content: r.stdout }; }
}

export * from "./openobserve.ts";
export * from "./trails.ts";
export * from "./voxq.ts";
