import type { TelemetryProvider } from "@ephyra/core";

/** Repository text is a hint, never credentials, authority, or proof of an active connection. */
export function detectTelemetry(files: Record<string, string>): TelemetryProvider[] {
  const text = Object.entries(files).map(([path, body]) => `${path}\n${body}`).join("\n").toLowerCase();
  const patterns: Record<TelemetryProvider, RegExp> = {
    sentry: /@sentry\/|sentry-cocoa|sentry-android|io\.sentry|sentry_sdk|sentry\.properties|sentry\.client/,
    crashlytics: /firebase-crashlytics|firebasecrashlytics|firebase_crashlytics|com\.google\.firebase\.crashlytics/,
    loki: /loki|promtail|grafana\/alloy/,
    axiom: /@axiomhq\/|axiom-node|axiom-go|axiom\.co/,
    betterstack: /@logtail\/|logtail|betterstack|better_stack/,
    datadog: /dd-trace|datadog|ddtrace/,
    bugsnag: /bugsnag/,
  };
  return (Object.keys(patterns) as TelemetryProvider[]).filter((provider) => patterns[provider].test(text));
}
