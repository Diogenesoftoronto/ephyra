// Additive contracts for referring Velum to parts of the console. A reference names a stable resource and the
// revision or range the person saw. The server reads the bounded record itself; display labels are never trusted.
import { z } from "zod";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const USAGE_FACETS = ["spend", "cumulative", "drivers", "outcomes", "forecast"] as const;
export const VelumReference = z.discriminatedUnion("kind", [
  /** An area of the application map, as published in autonomy.md at `revision` (the document digest or commit). */
  z.object({ kind: z.literal("area"), name: z.string().min(1).max(60), revision: z.string().min(1).max(128) }),
  z.object({ kind: z.literal("trail"), id: z.string().uuid(), rev: z.number().int().positive() }),
  z.object({ kind: z.literal("run"), id: z.string().min(1).max(200), status: z.string().max(40).optional() }),
  /** A usage chart or table for a closed UTC day range. */
  z.object({ kind: z.literal("usage"), facet: z.enum(USAGE_FACETS), from: Day, to: Day }),
  /** One artefact of a quest at the revision under review. */
  z.object({ kind: z.literal("evidence"), trailId: z.string().uuid(), rev: z.number().int().positive(), path: z.string().min(1).max(200) }),
]);
export type VelumReference = z.infer<typeof VelumReference>;
export const VELUM_MAX_REFERENCES = 6;

/** What the server resolved for one reference. `changed` and `missing` are refused before any model call. */
export const VelumResolvedReference = z.object({
  key: z.string(),
  label: z.string().max(200),
  status: z.enum(["current", "changed", "missing"]),
  /** The revision the server read now, when it differs from the one supplied. */
  current: z.string().max(128).optional(),
});
export type VelumResolvedReference = z.infer<typeof VelumResolvedReference>;

/** Stable identity for de-duplication, chips and highlights. Includes revision/range, so a newer revision is a new key. */
export function referenceKey(ref: VelumReference): string {
  switch (ref.kind) {
    case "area": return `area:${ref.name}@${ref.revision}`;
    case "trail": return `trail:${ref.id}@${ref.rev}`;
    case "run": return `run:${ref.id}`;
    case "usage": return `usage:${ref.facet}:${ref.from}..${ref.to}`;
    case "evidence": return `evidence:${ref.trailId}@${ref.rev}:${ref.path}`;
  }
}
/** The source identity without revision: two keys with the same source are the same thing at different times. */
export function referenceSource(ref: VelumReference): string {
  switch (ref.kind) {
    case "area": return `area:${ref.name}`;
    case "trail": return `trail:${ref.id}`;
    case "run": return `run:${ref.id}`;
    case "usage": return `usage:${ref.facet}`;
    case "evidence": return `evidence:${ref.trailId}:${ref.path}`;
  }
}

/** Add a reference, replacing an older revision of the same source; bounded to VELUM_MAX_REFERENCES (oldest dropped last). */
export function addReference<T extends { ref: VelumReference }>(list: readonly T[], next: T): { list: T[]; dropped: boolean } {
  const key = referenceKey(next.ref);
  if (list.some((r) => referenceKey(r.ref) === key)) return { list: [...list], dropped: false };
  const source = referenceSource(next.ref);
  const kept = list.filter((r) => referenceSource(r.ref) !== source);
  if (kept.length >= VELUM_MAX_REFERENCES) return { list: [...list], dropped: true };
  return { list: [...kept, next], dropped: false };
}

// ───── Profiles ─────
/** Public identity metadata from the Not Organic account authority. Never guessed: absent fields stay null. */
export const PersonProfile = z.object({
  did: z.string(),
  status: z.enum(["verified", "unavailable"]),
  handle: z.string().max(256).nullable(),
  displayName: z.string().max(256).nullable(),
  /** True when the server can proxy a validated avatar for this person; the URL itself is never sent. */
  avatar: z.boolean(),
  /** When the server last read this from Not Organic. */
  checkedAt: z.string().nullable(),
});
export type PersonProfile = z.infer<typeof PersonProfile>;
export const OwnProfile = PersonProfile.extend({
  /** Not Organic owns profile edits; this is the portal page that edits them. Null when unknown. */
  manageUrl: z.string().url().nullable(),
});
export type OwnProfile = z.infer<typeof OwnProfile>;
export const TeamPeople = z.object({ workspaceId: z.string(), people: z.array(PersonProfile).max(100) });
export type TeamPeople = z.infer<typeof TeamPeople>;

/** The label a person sees: display name, then handle. A DID is never the primary label. */
export function personLabel(p: Pick<PersonProfile, "displayName" | "handle"> | null | undefined, fallback = "Unverified account"): string {
  return p?.displayName?.trim() || (p?.handle ? `@${p.handle}` : fallback);
}

// ───── Usage forecast ─────
export const UsageForecastInput = z.object({
  /** Last complete UTC day the history ends on. The server refuses today or a future day. */
  asOf: Day,
  historyDays: z.number().int().min(7).max(90),
  horizonDays: z.number().int().min(1).max(30),
}).strict();
export type UsageForecastInput = z.infer<typeof UsageForecastInput>;
export const UsageForecastCapability = z.object({
  available: z.boolean(),
  /** The configured route. Null when forecasting is not configured. */
  provider: z.enum(["notorganic", "byok:cloudflare"]).nullable(),
  requestedModel: z.string().nullable(),
  reason: z.string().max(300),
  minCompleteDays: z.number().int(),
});
export type UsageForecastCapability = z.infer<typeof UsageForecastCapability>;
export const UsageForecastBasis = z.object({
  from: Day, to: Day, completeDays: z.number().int(), daysWithPricedSpend: z.number().int(),
  pricedEntries: z.number().int(), unknownCostEntries: z.number().int(), failedEntries: z.number().int(),
  /** Today's partial day is excluded from the history and shown separately. */
  excludedPartialDay: Day.nullable(),
});
export type UsageForecastBasis = z.infer<typeof UsageForecastBasis>;
export const UsageForecast = z.discriminatedUnion("status", [
  z.object({ status: z.literal("insufficient_history"), basis: UsageForecastBasis, required: z.number().int() }),
  z.object({
    status: z.literal("ok"),
    basis: UsageForecastBasis,
    /** Identity exactly as the provider returned it. */
    engine: z.string(),
    requestedModel: z.string(),
    operationKey: z.string(),
    /** Daily priced spend, microusd. Forecast values are not recorded spend. */
    days: z.array(z.object({ day: Day, median: z.number().nonnegative(), p10: z.number().nonnegative().nullable(), p90: z.number().nonnegative().nullable() })),
    pNull: z.number().nullable(),
    receipt: z.object({ tokens: z.number().int().nonnegative().nullable(), costMicrousd: z.number().int().nonnegative().nullable() }),
  }),
]);
export type UsageForecast = z.infer<typeof UsageForecast>;
