import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleApi, TrailDetail } from "../api.ts";
import type { AsyncState } from "./useAsync.ts";
import { followTrail, type TrailConnectionStatus, type TrailSnapshot } from "./followTrail.ts";

type Options = { onChanged?: () => void; pollMs?: number; timeoutMs?: number };
type BoundSnapshot = { api: ConsoleApi; id: string; value: TrailSnapshot };

/** Account/trail changes hide old data immediately. Refreshes and reconnects keep the current composer mounted. */
export function useTrail(api: ConsoleApi, trailId: string, options: Options = {}): {
  state: AsyncState<TrailDetail>;
  status: TrailConnectionStatus;
  error?: unknown;
  reload: () => void;
} {
  const [stored, setStored] = useState<BoundSnapshot>();
  const last = useRef<BoundSnapshot | undefined>(undefined);
  const changed = useRef(options.onChanged);
  changed.current = options.onChanged;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    const initial = last.current?.api === api && last.current.id === trailId ? last.current.value.data : undefined;
    let previous = initial;
    void followTrail(api, trailId, controller.signal, (value) => {
      if (controller.signal.aborted) return;
      const next = { api, id: trailId, value };
      last.current = next;
      setStored(next);
      if (previous && value.data && previous !== value.data) changed.current?.();
      if (value.data) previous = value.data;
    }, { initial, pollMs: options.pollMs, timeoutMs: options.timeoutMs });
    return () => controller.abort();
  }, [api, trailId, tick, options.pollMs, options.timeoutMs]);
  const snapshot = stored?.api === api && stored.id === trailId ? stored.value : undefined;
  const status = snapshot?.status ?? "connecting";
  const state: AsyncState<TrailDetail> = snapshot?.data
    ? { status: "ready", data: snapshot.data, refreshing: status === "reconnecting" }
    : snapshot?.error ? { status: "error", error: snapshot.error } : { status: "loading" };
  return { state, status, error: snapshot?.error, reload };
}
