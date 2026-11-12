import { expect, test } from "bun:test";
import fc from "fast-check";
import { TelemetryProvider, TelemetrySourceUpdate } from "../src/telemetry-providers";
const input = { id: "source", provider: "sentry", workspaceId: "workspace", enabled: true, origin: "https://sentry.io", project: "org/project", expectedVersion: 0 };
test("telemetry writes reject control characters and unknown credential fields", () => {
  fc.assert(fc.property(fc.constantFrom("\r", "\n", "\0"), fc.string(), (control, text) => {
    expect(TelemetrySourceUpdate.safeParse({ ...input, credentials: { apiKey: `before${control}${text}after` } }).success).toBe(false);
  }));
  expect(TelemetrySourceUpdate.safeParse({ ...input, credentials: { apiKey: "key", password: "extra" } }).success).toBe(false);
});
test("every declared provider supports additive source updates", () => {
  for (const provider of TelemetryProvider.options) expect(TelemetrySourceUpdate.parse({ ...input, provider }).provider).toBe(provider);
});
