// Fictional fixtures for profiles, Velum conversation and usage forecasts. Storybook/tests only unless a demo option
// opts in; nothing here contacts a provider, and fixture identities are labelled as such.
import {
  referenceKey, VoiceReplyInput, type OwnProfile, type PersonProfile, type TeamPeople, type UsageEntry, type UsageForecast,
  type UsageForecastCapability, type UsageForecastInput, type VoiceReply,
} from "@ephyra/core";
import { VoiceRequestError } from "../api.ts";

export type ForecastMode = "unavailable" | "ok" | "insufficient" | "uncertain" | "rate-limited" | "rate-limited-unknown" | "error" | "hang";
export type ConversationMode = "unavailable" | "fixture" | "uncertain" | "rate-limited" | "hang" | "stale-reference";

export const FIXTURE_PEOPLE: Record<string, Omit<PersonProfile, "did">> = {
  "did:web:alex.example": { status: "verified", handle: "alex.fixture.test", displayName: "Alex (fixture)", avatar: false, checkedAt: "2026-11-07T14:00:00.000Z" },
  "did:plc:storybook-owner": { status: "verified", handle: "owner.fixture.test", displayName: "Rowan (fixture)", avatar: false, checkedAt: "2026-11-07T14:00:00.000Z" },
  "did:plc:storybook-viewer": { status: "verified", handle: "viewer.fixture.test", displayName: null, avatar: false, checkedAt: "2026-11-07T14:00:00.000Z" },
  "did:plc:storybook-approver": { status: "unavailable", handle: null, displayName: null, avatar: false, checkedAt: null },
};
export function fixtureProfile(did: string): PersonProfile {
  return { did, ...(FIXTURE_PEOPLE[did] ?? { status: "unavailable", handle: null, displayName: null, avatar: false, checkedAt: null }) };
}
export function fixtureOwnProfile(did: string): OwnProfile {
  return { ...fixtureProfile(did), manageUrl: "https://id.notorganic.test/?view=profile" };
}
export function fixturePeople(workspaceId: string, dids: string[]): TeamPeople {
  return { workspaceId, people: [...new Set(dids)].map(fixtureProfile) };
}

export function forecastCapability(mode: ForecastMode): UsageForecastCapability {
  return mode === "unavailable"
    ? { available: false, provider: null, requestedModel: null, minCompleteDays: 7, reason: "No verified Clairic forecast route is configured. Set EPHYRA_FORECAST to notorganic or workers-ai." }
    : { available: true, provider: "notorganic", requestedModel: "extraction", minCompleteDays: 7, reason: "Fixture route. Runs only when you ask; no provider is contacted in Storybook." };
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export function fixtureForecast(rows: UsageEntry[], input: UsageForecastInput, now: number, mode: ForecastMode, op: string): UsageForecast {
  const end = Date.parse(`${input.asOf}T00:00:00Z`);
  const from = end - (input.historyDays - 1) * DAY;
  const inRange = rows.filter((r) => { const t = Date.parse(r.at.slice(0, 10)); return t >= from && t <= end; });
  const days = new Set(inRange.filter((r) => r.costMicrousd !== null).map((r) => r.at.slice(0, 10)));
  const basis = {
    from: iso(from), to: input.asOf, completeDays: input.historyDays, daysWithPricedSpend: days.size,
    pricedEntries: inRange.filter((r) => r.costMicrousd !== null).length,
    unknownCostEntries: inRange.filter((r) => r.costMicrousd === null).length,
    failedEntries: inRange.filter((r) => r.outcome === "failed").length,
    excludedPartialDay: iso(Math.floor(now / DAY) * DAY),
  };
  if (mode === "insufficient" || days.size < 3) return { status: "insufficient_history", basis, required: 7 };
  const priced = inRange.reduce((n, r) => n + (r.costMicrousd ?? 0), 0) / Math.max(1, input.historyDays);
  return {
    status: "ok", basis, engine: "clairic-fixture (not a live model)", requestedModel: "extraction", operationKey: op, pNull: 0.04,
    receipt: { tokens: 412, costMicrousd: 41 },
    days: Array.from({ length: input.horizonDays }, (_, i) => {
      const median = Math.round(priced * (1 + 0.03 * i));
      return { day: iso(end + (i + 1) * DAY), median, p10: Math.round(median * 0.6), p90: Math.round(median * 1.5) };
    }),
  };
}
export function forecastFailure(mode: ForecastMode, op: string): Error | null {
  if (mode === "uncertain") return new VoiceRequestError("reconciliation_required", "The forecast request may have been billed. Check Usage before asking again.", op);
  if (mode === "rate-limited") return new VoiceRequestError("rate_limited", "The forecast provider is rate limited.", op, undefined, 30);
  if (mode === "rate-limited-unknown") return new VoiceRequestError("rate_limited", "The forecast provider is rate limited.", op);
  if (mode === "error") return new VoiceRequestError("malformed", "The forecast came back incomplete. Nothing was drawn.", op);
  return null;
}

/** A clearly fictional reply that names exactly what the server would have resolved. */
export function fixtureReply(input: VoiceReplyInput, mode: ConversationMode, op: string): VoiceReply {
  const parsed = VoiceReplyInput.parse(input);
  const refs = parsed.references ?? [];
  if (mode === "stale-reference" && refs.length)
    throw new VoiceRequestError("reference_changed", "Something you referred to changed after you selected it. Refresh it, then send again.", op,
      refs.map((r, i) => ({ key: referenceKey(r), label: r.kind, status: i === 0 ? "changed" as const : "current" as const, ...(i === 0 ? { current: "newer" } : {}) })));
  if (mode === "uncertain") throw new VoiceRequestError("reconciliation_required", "The connection ended before the reply finished. Check Usage before trying again.", op);
  if (mode === "rate-limited") throw new VoiceRequestError("rate_limited", "Velum is rate limited by its provider.", op);
  const last = parsed.messages.at(-1)!.text;
  const named = refs.map((r) => referenceKey(r).split("@")[0]).join(", ");
  return {
    text: `Fixture reply, not a live model. You asked: “${last.slice(0, 120)}”.` + (refs.length ? ` I read ${refs.length} referenced item${refs.length === 1 ? "" : "s"}: ${named}.` : " No references were attached."),
    contextLabel: parsed.context.kind,
    references: refs.map((r) => ({ key: referenceKey(r), label: referenceKey(r).split("@")[0]!, status: "current" as const })),
    receipt: { operationKey: op, engine: "fixture/velum (not a live model)", requestedModel: "fixture", tokens: null, costMicrousd: null, billedTo: "local" },
  };
}
