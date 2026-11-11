import { UsageForecastInput } from "@ephyra/core";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type ForecastOperation = { op: string; input: UsageForecastInput | null };
const LEGACY_KEY = "ephyra.forecast-op";
const key = (scope: string) => `${LEGACY_KEY}:${encodeURIComponent(scope)}`;

/** Save the exact request, not just its key: a horizon change or midnight must not alter recovery. No credentials. */
export function rememberForecastOperation(storage: Store, scope: string, operation: ForecastOperation): void {
  try { storage.setItem(key(scope), JSON.stringify({ scope, ...operation })); } catch { /* memory only */ }
}
export function readForecastOperation(storage: Store, scope: string): ForecastOperation | null {
  try {
    const value = JSON.parse(storage.getItem(key(scope)) ?? storage.getItem(LEGACY_KEY) ?? "null");
    if (value?.scope !== scope || typeof value.op !== "string" || !/^[A-Za-z0-9:_-]{8,160}$/.test(value.op)) return null;
    // Older builds only stored a key. Retain its uncertainty, but never guess the missing request parameters.
    if (value.input == null) return { op: value.op, input: null };
    const input = UsageForecastInput.safeParse(value.input);
    return input.success ? { op: value.op, input: input.data } : null;
  } catch { return null; }
}
export function forgetForecastOperation(storage: Store, scope: string): void {
  try {
    storage.removeItem(key(scope));
    if (JSON.parse(storage.getItem(LEGACY_KEY) ?? "null")?.scope === scope) storage.removeItem(LEGACY_KEY);
  } catch { /* storage blocked */ }
}
