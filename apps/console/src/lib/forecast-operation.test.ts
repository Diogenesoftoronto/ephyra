import { expect, test } from "bun:test";
import fc from "fast-check";
import { forgetForecastOperation, readForecastOperation, rememberForecastOperation } from "./forecast-operation.ts";

function store() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
test("forecast recovery retains the original input in each scope, including across midnight and changed defaults", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 7, max: 90 }), (horizonDays, historyDays) => {
    const storage = store();
    const original = { op: "forecast-original", input: { asOf: "2026-11-10", historyDays, horizonDays } };
    rememberForecastOperation(storage, "account:a/workspace:1", original);
    rememberForecastOperation(storage, "account:b/workspace:2", { op: "forecast-other-key", input: { asOf: "2026-11-11", historyDays: 28, horizonDays: 7 } });
    expect(readForecastOperation(storage, "account:a/workspace:1")).toEqual(original);
    forgetForecastOperation(storage, "account:b/workspace:2");
    expect(readForecastOperation(storage, "account:a/workspace:1")).toEqual(original);
    expect(readForecastOperation(storage, "account:b/workspace:2")).toBeNull();
  }));
});
test("old key-only operations stay unresolved instead of borrowing today's dates or horizon", () => {
  const storage = store();
  storage.setItem("ephyra.forecast-op", JSON.stringify({ scope: "a", op: "forecast-legacy-key" }));
  expect(readForecastOperation(storage, "a")).toEqual({ op: "forecast-legacy-key", input: null });
  forgetForecastOperation(storage, "b");
  expect(readForecastOperation(storage, "a")?.op).toBe("forecast-legacy-key");
  forgetForecastOperation(storage, "a");
  expect(readForecastOperation(storage, "a")).toBeNull();
});
