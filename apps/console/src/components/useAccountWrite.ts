import { useRef, useState } from "react";
import type { AccountSettings } from "@ephyra/core";
import type { AccountApi } from "../account-api.ts";
import { ApiError, UnknownWriteOutcome } from "../api.ts";

export type AccountWriteState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "refreshing" }
  | { kind: "saved"; message: string }
  | { kind: "error" | "stale" | "uncertain"; message: string };

/** Keeps retries of one unchanged intent on the same operation, only in memory. */
export class AccountOperation {
  private current: { intent: string; key: string } | undefined;
  key(input: unknown): string {
    const intent = JSON.stringify(input);
    if (this.current?.intent !== intent) this.current = { intent, key: `account-${crypto.randomUUID()}` };
    return this.current.key;
  }
  clear() {
    this.current = undefined;
  }
}

export function useAccountWrite(api: AccountApi, onChange: (settings: AccountSettings) => void) {
  const operation = useRef(new AccountOperation());
  const active = useRef(false);
  const uncertain = useRef(false);
  const [state, setState] = useState<AccountWriteState>({ kind: "idle" });
  const busy = state.kind === "saving" || state.kind === "refreshing";

  async function save<T>(input: T, write: (input: T, key: string) => Promise<AccountSettings>, message: string) {
    if (active.current || uncertain.current) return null;
    active.current = true;
    setState({ kind: "saving" });
    try {
      const next = await write(input, operation.current.key(input));
      operation.current.clear();
      setState({ kind: "saved", message });
      onChange(next);
      return next;
    } catch (error) {
      if (error instanceof UnknownWriteOutcome) {
        uncertain.current = true;
        setState({
          kind: "uncertain",
          message:
            "The connection ended before we could confirm the save. It may have completed. Refresh saved settings before making another change.",
        });
      } else if (error instanceof ApiError && error.status === 409) {
        setState({
          kind: "stale",
          message: "Settings changed in another window. Refresh saved settings, then review your changes.",
        });
      } else if (error instanceof ApiError && error.status === 401) {
        setState({ kind: "error", message: "Your session has expired. Sign in again to save these settings." });
      } else {
        setState({
          kind: "error",
          message:
            error instanceof ApiError && error.detail
              ? error.detail
              : "These settings could not be saved. Check your entries and try again.",
        });
      }
      return null;
    } finally {
      active.current = false;
    }
  }

  async function refresh() {
    if (active.current) return;
    active.current = true;
    setState({ kind: "refreshing" });
    try {
      const next = await api.settings();
      uncertain.current = false;
      onChange(next);
      setState({ kind: "saved", message: "Latest saved settings loaded. Review them before trying again." });
    } catch {
      setState({
        kind: uncertain.current ? "uncertain" : "error",
        message:
          "Saved settings could not be reached. Nothing was retried. Try refreshing again when the connection returns.",
      });
    } finally {
      active.current = false;
    }
  }

  return { state, busy, locked: busy || uncertain.current || state.kind === "stale", save, refresh };
}
