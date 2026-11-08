import { ApiError, type ConsoleApi, type TrailDetail } from "../api.ts";

export type TrailConnectionStatus = "connecting" | "live" | "disconnected" | "reconnecting" | "error";
export type TrailSnapshot = { data?: TrailDetail; status: TrailConnectionStatus; error?: unknown };
export type FollowTrailOptions = { pollMs?: number; timeoutMs?: number; maxRetryMs?: number; initial?: TrailDetail };

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Bound each read, abort its transport, and ignore a late response even from a custom adapter. */
async function read(api: Pick<ConsoleApi, "trail">, id: string, signal: AbortSignal, timeoutMs: number) {
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => {
      request.abort();
      reject(new Error("Quest read was cancelled."));
    };
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      request.abort();
      reject(new Error("The quest server did not answer in time."));
    }, timeoutMs);
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([api.trail(id, request.signal), interrupted]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", cancel);
  }
}

/** Poll authenticated snapshots; errors never erase the last recorded discussion or imply live presence. */
export async function followTrail(
  api: Pick<ConsoleApi, "trail">,
  id: string,
  signal: AbortSignal,
  publish: (snapshot: TrailSnapshot) => void,
  options: FollowTrailOptions = {},
): Promise<void> {
  const pollMs = Math.max(0, options.pollMs ?? 2000);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
  const maxRetryMs = Math.max(pollMs, options.maxRetryMs ?? 30_000);
  let data = options.initial;
  let encoded = data ? JSON.stringify(data) : undefined;
  let status: TrailConnectionStatus | undefined;
  let lastError: unknown;
  let failures = 0;
  const show = (next: TrailConnectionStatus, error?: unknown, changed = false) => {
    if (signal.aborted || (!changed && status === next && lastError === error)) return;
    status = next;
    lastError = error;
    publish({ data, status: next, ...(error === undefined ? {} : { error }) });
  };
  show(data ? "reconnecting" : "connecting");
  while (!signal.aborted) {
    try {
      const next = await read(api, id, signal, timeoutMs);
      if (signal.aborted) return;
      const nextEncoded = JSON.stringify(next);
      const changed = nextEncoded !== encoded;
      if (changed) {
        data = next;
        encoded = nextEncoded;
      }
      failures = 0;
      show("live", undefined, changed);
      await delay(pollMs, signal);
    } catch (error) {
      if (signal.aborted) return;
      // Retain the snapshot, but require an explicit reload after revoked access or a removed trail.
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        show("error", error);
        return;
      }
      show("disconnected", error);
      const backoff = Math.min(maxRetryMs, Math.max(1, pollMs) * 2 ** Math.min(failures++, 10));
      await delay(backoff, signal);
      show("reconnecting", error);
    }
  }
}
