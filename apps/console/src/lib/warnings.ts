// The server returns parser output as strings. `parseAutonomy` throws on invalid or malformed input
// ("line 7: invalid risk") and records recoverable problems as warnings ("line 4: unknown key faceted").
// The console treats the first kind as blocking. This is a convention, not part of the core contract (Unverified).
const BLOCKING = /\b(invalid|malformed|must be|cannot parse|parse error)\b/i;

export const isBlocking = (warning: string): boolean => BLOCKING.test(warning);
export const hasBlocking = (warnings: readonly string[]): boolean => warnings.some(isBlocking);
export const splitWarnings = (warnings: readonly string[]) => ({
  errors: warnings.filter(isBlocking),
  notes: warnings.filter((w) => !isBlocking(w)),
});
