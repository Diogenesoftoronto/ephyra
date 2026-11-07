import type { Signal, SignalStore } from "@ephyra/core";
export class MemorySignalStore implements SignalStore {
  private signals = new Map<string, Signal>();
  private occurrences = new Map<string, { at: number; count: number }[]>();
  private muted = new Map<string, number>();
  private requests: { route: string; at: number; error: boolean }[] = [];
  async upsert(s: Signal) {
    const old = this.signals.get(s.fingerprint);
    const signal = old
      ? {
          ...old,
          count: old.count + s.count,
          lastSeen: old.lastSeen > s.lastSeen ? old.lastSeen : s.lastSeen,
          firstSeen: old.firstSeen < s.firstSeen ? old.firstSeen : s.firstSeen,
        }
      : structuredClone(s);
    this.signals.set(s.fingerprint, signal);
    const list = this.occurrences.get(s.fingerprint) ?? [];
    list.push({ at: Date.parse(s.lastSeen), count: s.count });
    this.occurrences.set(s.fingerprint, list);
    return { signal: structuredClone(signal), isNew: !old };
  }
  async get(id: string) {
    return structuredClone(
      [...this.signals.values()].find((s) => s.id === id) ?? null,
    );
  }
  async byFingerprint(fp: string) {
    return structuredClone(this.signals.get(fp) ?? null);
  }
  async countSince(fp: string, since: Date) {
    return (this.occurrences.get(fp) ?? [])
      .filter((x) => x.at >= +since)
      .reduce((n, x) => n + x.count, 0);
  }
  async newFingerprintsInFiles(files: string[], since: Date) {
    return structuredClone(
      [...this.signals.values()].filter(
        (s) =>
          Date.parse(s.firstSeen) >= +since &&
          files.includes(s.frames.find((f) => f.inApp)?.file ?? ""),
      ),
    );
  }
  recordRequest(route: string, at: Date, error: boolean) {
    this.requests.push({ route, at: +at, error });
  }
  async errorRate(route: string, from: Date, to: Date) {
    const entries = this.requests.filter(
      (x) => x.route === route && x.at >= +from && x.at < +to,
    );
    return entries.length
      ? {
          requests: entries.length,
          errors: entries.filter((x) => x.error).length,
        }
      : null;
  }
  async mute(fp: string, until: Date) {
    this.muted.set(fp, +until);
  }
  async isMuted(fp: string, at: Date) {
    return (this.muted.get(fp) ?? 0) > +at;
  }
}
