import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** `null` means the real clock. Stories and tests pass a fixed time so elapsed counters never move. */
const ClockContext = createContext<number | null>(null);

export function ClockProvider({ now, children }: { now: number | null; children: ReactNode }) {
  return <ClockContext.Provider value={now}>{children}</ClockContext.Provider>;
}

/** The current time in ms. With a fixed clock it never changes; with the real one it ticks every `tickMs`. */
export function useNow(tickMs = 1000): number {
  const fixed = useContext(ClockContext);
  const [real, setReal] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== null) return;
    const id = setInterval(() => setReal(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [fixed, tickMs]);
  return fixed ?? real;
}
