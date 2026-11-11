import { createContext, useContext, type ReactNode } from "react";
import type { ConsoleApi } from "../api.ts";

const ApiContext = createContext<ConsoleApi | null>(null);

export function ApiProvider({ api, children }: { api: ConsoleApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ConsoleApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi needs an ApiProvider");
  return api;
}

/** For components that also render outside the console (Storybook, setup screens). */
export function useOptionalApi(): ConsoleApi | null {
  return useContext(ApiContext);
}
