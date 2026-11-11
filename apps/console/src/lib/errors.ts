import { ApiError, UnknownWriteOutcome } from "../api.ts";

export type Described = {
  title: string;
  body: string;
  kind: "stale" | "forbidden" | "unknown-outcome" | "unavailable" | "not-found" | "rate-limited" | "other";
};

/** Plain-language text for a failed call. Server text is shown as text only, and only when it is short. */
export function describeError(error: unknown): Described {
  if (error instanceof UnknownWriteOutcome) {
    return {
      kind: "unknown-outcome",
      title: "We could not confirm that change",
      body: "The connection dropped before the answer came back. Refresh to see whether it went through before you try again.",
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 401) return {
      kind: "forbidden", title: "Your session has ended", body: "Sign in again to continue in this workspace.",
    };
    const detail = error.detail ? ` (${error.detail})` : "";
    if (error.status === 409)
      return {
        kind: "stale",
        title: "This changed while you were looking",
        body: `Reload to see the latest version${detail}.`,
      };
    if (error.status === 403)
      return {
        kind: "forbidden",
        title: "You are not an approver here",
        body: error.detail ?? "Ask an approver to make this change.",
      };
    if (error.status === 404)
      return {
        kind: "not-found",
        title: "Not found",
        body: "It may have been removed. Go back and refresh.",
      };
    if (error.status === 503 || error.status === 502) {
      return {
        kind: "unavailable",
        title: "This is not available right now",
        body: error.detail ?? "The service did not answer. Nothing was changed.",
      };
    }
    return {
      kind: "other",
      title: "The server could not do that",
      body: `It answered ${error.status}${detail}.`,
    };
  }
  return {
    kind: "other",
    title: "Something went wrong",
    body: error instanceof Error ? error.message : "Unknown error.",
  };
}
