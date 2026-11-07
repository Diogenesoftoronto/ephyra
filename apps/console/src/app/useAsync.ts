import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncState<T> = { status: "loading" } | { status: "ready"; data: T; refreshing: boolean } | { status: "error"; error: unknown };

/** Load once per `key` change, keep the old data on screen while reloading, and expose `reload` and `set`. */
export function useAsync<T>(load: () => Promise<T>, key: string): { state: AsyncState<T>; reload: () => void; set: (data: T) => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    setState((s) => (s.status === "ready" ? { ...s, refreshing: true } : { status: "loading" }));
    loadRef.current().then(
      (data) => { if (live) setState({ status: "ready", data, refreshing: false }); },
      (error: unknown) => { if (live) setState({ status: "error", error }); },
    );
    return () => { live = false; };
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((data: T) => setState({ status: "ready", data, refreshing: false }), []);
  return { state, reload, set };
}
