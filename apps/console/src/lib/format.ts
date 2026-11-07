// Display formatting. Unknown is never zero: a null cost reads "unknown".
import type { UsageTotals } from "@ephyra/core";

export const UNKNOWN = "unknown";

export function formatMicrousd(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return UNKNOWN;
  if (micro === 0) return "$0.00";
  if (micro < 10_000) return "<$0.01";
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

/** A known total plus how many rows could not be priced: `$4.20 + 3 unknown`. */
export function formatTotalCost(totals: Pick<UsageTotals, "costMicrousd" | "unknownCost">): string {
  const known = formatMicrousd(totals.costMicrousd);
  if (totals.unknownCost === 0) return known;
  return totals.costMicrousd === 0
    ? `${UNKNOWN} (${totals.unknownCost})`
    : `${known} + ${totals.unknownCost} ${UNKNOWN}`;
}

export function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return UNKNOWN;
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return UNKNOWN;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function elapsedMs(startedAt: string, now: number): number {
  return Math.max(0, now - Date.parse(startedAt));
}

export function relativeTime(at: string, now: number): string {
  const s = Math.round((now - Date.parse(at)) / 1000);
  if (s < 0) return "in the future";
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function clockTime(at: string): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

export const shortDigest = (d: string) => d.replace(/^sha256:/, "").slice(0, 10);
export const shortSha = (s: string) => s.slice(0, 8);

/** Whole-day label for chart axes, e.g. "Nov 7". */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

export function percent(used: number, max: number): number {
  return max <= 0 ? 0 : Math.min(100, Math.round((used / max) * 100));
}

/** Only http(s) URLs may become links; anything else is shown as text. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}
