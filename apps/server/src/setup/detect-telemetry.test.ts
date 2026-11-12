import { expect, test } from "bun:test";
import { detectTelemetry } from "./detect-telemetry";
test("detects native mobile and browser instrumentation without interpreting credentials", () => {
  expect(detectTelemetry({ "package.json": '{"dependencies":{"@sentry/react":"1", "@axiomhq/js":"1"}}',
    "app/build.gradle.kts": 'implementation("com.google.firebase:firebase-crashlytics")', "Podfile": "pod 'Bugsnag'" }))
    .toEqual(["sentry", "crashlytics", "axiom", "bugsnag"]);
  expect(detectTelemetry({ "package.json": '{"dependencies":{"react":"19"}}' })).toEqual([]);
});
