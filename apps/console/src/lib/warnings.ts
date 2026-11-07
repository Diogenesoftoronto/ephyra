// The server reports parser output as strings. A parse error carries an `error:` prefix and blocks applying and
// publishing; anything else is a warning (apps/server/README.md, "Documents").
const BLOCKING = /^error:/i;

export const isBlocking = (warning: string): boolean => BLOCKING.test(warning);
export const hasBlocking = (warnings: readonly string[]): boolean => warnings.some(isBlocking);
export const splitWarnings = (warnings: readonly string[]) => ({
  errors: warnings.filter(isBlocking).map((w) => w.replace(BLOCKING, "").trim()),
  notes: warnings.filter((w) => !isBlocking(w)),
});
