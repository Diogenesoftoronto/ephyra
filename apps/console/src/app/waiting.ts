// How many things are waiting on a person, as the live board last heard it. The navigation badge reads this while a
// page that polls is open, so the badge and the page never disagree. Null means nobody is publishing a live count.
import { useSyncExternalStore } from "react";

let count: number | null = null;
const listeners = new Set<() => void>();

export function publishWaiting(next: number | null): void {
  if (next === count) return;
  count = next;
  for (const listener of listeners) listener();
}

export function useWaiting(): number | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => count,
    () => null,
  );
}
