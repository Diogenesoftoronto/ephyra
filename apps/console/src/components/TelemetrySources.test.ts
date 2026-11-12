import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TelemetrySources, TelemetrySourceForm } from "./TelemetrySources.tsx";
import { TELEMETRY_PROVIDERS } from "./telemetry-catalog.ts";
import { ACCOUNT_FIXTURE, FakeAccountApi } from "../fake/account.ts";

const source = { id: "sentry", provider: "sentry" as const, workspaceId: ACCOUNT_FIXTURE.workspaceId, enabled: true,
  origin: "https://sentry.io", project: "team/app", expectedVersion: 0, credentials: { apiKey: "private-fixture-key" } };

test("provider picker names all sources and uses locally bundled, attributed marks", () => {
  const html = renderToStaticMarkup(createElement(TelemetrySources, {
    api: new FakeAccountApi(), settings: ACCOUNT_FIXTURE, onChange: () => {},
  }));
  const assets = join(import.meta.dir, "../../public/providers");
  const manifest = JSON.parse(readFileSync(join(assets, "sources.json"), "utf8")) as Array<{ slug: string; file?: string; source: string; sha256: string }>;
  for (const provider of TELEMETRY_PROVIDERS) {
    expect(html).toContain(provider.name);
    expect(existsSync(join(assets, provider.logo))).toBeTrue();
    const attribution = manifest.find((entry) => (entry.file ?? `${entry.slug}.svg`) === provider.logo)!;
    expect(attribution.source).toStartWith("https://");
    expect(createHash("sha256").update(readFileSync(join(assets, provider.logo))).digest("hex")).toBe(attribution.sha256);
  }
  expect(html).toContain("aria-pressed=\"false\"");
  expect(html).not.toContain("Access checked");
  expect(html).toContain("Embrace and mobile OpenTelemetry");
  expect(html).toContain("Railway application logs");
  expect(html).not.toContain("https://raw.githubusercontent.com");
});

test("provider forms offer matching credentials and state access limits", () => {
  for (const provider of TELEMETRY_PROVIDERS) {
    const html = renderToStaticMarkup(createElement(TelemetrySourceForm, {
      api: new FakeAccountApi(), settings: ACCOUNT_FIXTURE, onChange: () => {}, provider,
    }));
    expect(html).toContain(`${provider.name} connection`);
    expect(html).toContain(provider.projectLabel);
    expect(html).toContain("Check access and save");
    expect(html).toContain("does not run an agent or prove the application is healthy");
    if (provider.id === "crashlytics") {
      expect(html).toContain("Service account JSON"); expect(html).toContain("roles/logging.viewer");
    } else expect(html).toContain('type="password"');
    if (provider.id === "datadog") expect(html).toContain("Application key");
    if (provider.id === "betterstack") expect(html).toContain("Query API username");
  }
});

test("source fixture preserves idempotency and account boundaries without exposing or verifying credentials", async () => {
  const api = new FakeAccountApi();
  const saved = await api.saveTelemetrySource(source, "source-save");
  expect(await api.saveTelemetrySource(source, "source-save")).toEqual(saved);
  expect(saved.telemetrySources?.[0]?.status).toBe("saved");
  expect(saved.telemetrySources?.[0]?.checkedAt).toBeNull();
  expect(JSON.stringify(saved)).not.toContain(source.credentials.apiKey);
  const { credentials, ...withoutSecret } = source;
  const moved = await api.saveTelemetrySource({ ...withoutSecret, project: "team/other", expectedVersion: 1 }, "source-move");
  expect(moved.telemetrySources?.[0]?.keyConfigured).toBeFalse();
  await expect(api.saveTelemetrySource({ ...source, workspaceId: "another", expectedVersion: 2 }, "source-stale"))
    .rejects.toMatchObject({ status: 409 });
  const disconnected = await api.saveTelemetrySource({ ...withoutSecret, enabled: false, clearKey: true, expectedVersion: 2 }, "source-disconnect");
  expect(disconnected.telemetrySources?.[0]?.keyConfigured).toBeFalse();
});

test("collector credentials stay unfetched during rendering and require a connected repository", () => {
  const api = new FakeAccountApi();
  let called = false;
  api.telemetryOtlp = async () => { called = true; throw new Error("must not fetch during render"); };
  const html = renderToStaticMarkup(createElement(TelemetrySources, { api, settings: ACCOUNT_FIXTURE, onChange: () => {} }));
  expect(called).toBeFalse();
  expect(html).toContain("Connect a repository first");
  expect(html).not.toContain("fictional-collector-token");
});
