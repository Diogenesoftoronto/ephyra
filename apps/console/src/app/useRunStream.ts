import { useEffect, useState } from "react";
import type { ConsoleApi } from "../api.ts";
import { followRun, type RunSnapshot } from "./followRun.ts";
export type RunStream =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | ({ status: "ready" } & RunSnapshot);
export function useRunStream(api: ConsoleApi, runId: string, retryMs = 2000): RunStream {
  const [state, setState] = useState<RunStream>({ status: "loading" });
  useEffect(() => {
    const ctl = new AbortController();
    setState({ status: "loading" });
    void followRun(
      api,
      runId,
      ctl.signal,
      (snapshot) => setState({ status: "ready", ...snapshot }),
      retryMs,
    ).catch((error: unknown) => {
      if (!ctl.signal.aborted) setState({ status: "error", error });
    });
    return () => ctl.abort();
  }, [api, runId, retryMs]);
  return state;
}
