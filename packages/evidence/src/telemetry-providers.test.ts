import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import fc from "fast-check";
import { TelemetryProviderEvidence, type TelemetryConnection, type TelemetryProvider, type TelemetryProviderOptions } from "./telemetry-providers.ts";

const NOW = "2026-11-12T12:00:00.000Z";
const AT = "2026-11-12T11:30:00.000Z";
const credential = { apiKey: "secret-provider-key", applicationKey: "secret-application-key", username: "reader" };
const configs: Record<TelemetryProvider, Pick<TelemetryConnection, "origin" | "project">> = {
  sentry: { origin: "https://sentry.io", project: "acme/mobile" },
  crashlytics: { origin: "https://logging.googleapis.com", project: "acme-mobile" },
  loki: { origin: "https://logs.acme.com", project: "mobile-api" },
  axiom: { origin: "https://eu-central-1.aws.edge.axiom.co", project: "mobile-logs" },
  betterstack: { origin: "https://eu-nbg-2-connect.betterstackdata.com", project: "t123456_mobile_logs" },
  datadog: { origin: "https://api.datadoghq.eu", project: "mobile-api" },
  bugsnag: { origin: "https://api.bugsnag.com", project: "abc123" },
};
const bodies: Record<TelemetryProvider, unknown> = {
  sentry: [{ eventID: "event-1", dateCreated: AT, message: "Checkout exception secret-provider-key", groupID: "issue-1", level: "error", tags: [{ key: "release", value: "mobile@12" }], user: { email: "private@example.com" }, entries: [{ type: "exception", data: { values: [{ type: "TypeError", value: "Checkout failure", stacktrace: { frames: [{ filename: "checkout.ts", function: "checkout", lineNo: 12, vars: { password: "hidden" } }] } }] } }] }],
  crashlytics: { entries: [{ insertId: "crash-1", timestamp: AT, jsonPayload: { issue: { id: "issue-1", title: "Checkout", subtitle: "Exception", errorType: "FATAL" }, version: { displayVersion: "1.2", buildVersion: "123" }, user: { email: "private@example.com" } } }] },
  loki: { status: "success", data: { resultType: "streams", result: [{ stream: { service_name: "mobile-api", level: "error", email: "private@example.com" }, values: [[String(BigInt(Date.parse(AT)) * 1000000n), "Checkout exception"]] }] } },
  axiom: { status: { isPartial: false }, tables: [{ fields: [{ name: "_time" }, { name: "message" }, { name: "level" }], columns: [[AT], ["Checkout exception"], ["error"]] }] },
  betterstack: JSON.stringify({ dt: AT, raw: JSON.stringify({ message: "Checkout exception", level: "error", email: "private@example.com" }) }) + "\n",
  datadog: { data: [{ id: "event-1", attributes: { timestamp: AT, message: "Checkout exception", status: "error", service: "mobile-api", attributes: { email: "private@example.com" } } }] },
  bugsnag: [{ id: "issue-1", last_seen: AT, error_class: "Error", message: "Checkout exception", severity: "error", users: [{ email: "private@example.com" }] }],
};
function fixture(provider: TelemetryProvider, overrides: Partial<TelemetryProviderOptions> = {}, payload: unknown = bodies[provider]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const options: TelemetryProviderOptions = {
    connection: { id: "main", provider, ...configs[provider] }, scope: { accountId: "did:owner", workspaceId: "workspace-1" },
    credential: async () => credential, authorize: async () => true, now: () => new Date(NOW),
    fetcher: async (url, init) => { calls.push({ url, init }); return new Response(typeof payload === "string" ? payload : JSON.stringify(payload)); },
    ...overrides,
  };
  return { adapter: new TelemetryProviderEvidence(options), calls, options };
}

describe("provider telemetry contracts", () => {
  for (const provider of Object.keys(configs) as TelemetryProvider[]) {
    test(`${provider}: real request contract, sanitized records, immutable receipts`, async () => {
      const { adapter, calls } = fixture(provider);
      const result = await adapter.observe();
      expect(result.events).toHaveLength(1);
      expect(result.events[0]!.timestamp).toBe(AT);
      expect(result.coverage).toBe("partial");
      expect(result.limitations.join(" ")).toContain("not proof");
      expect(JSON.stringify(result)).not.toContain("secret-provider-key");
      expect(JSON.stringify(result)).not.toContain("private@example.com");
      expect(JSON.stringify(result)).not.toContain('"vars"');
      expect(calls[0]!.init?.redirect).toBe("error");
      expect(calls[0]!.url.startsWith(configs[provider].origin)).toBe(true);
      const hit = (await adapter.search({ text: "checkout", limit: 1 }))[0]!;
      expect(hit.snippet).toStartWith("<untrusted_telemetry>");
      const value = await adapter.fetch({ ...hit, snippet: "forged", uri: "https://evil.example" });
      expect(value.content).not.toContain("forged");
      expect(calls).toHaveLength(2);
      expect((await adapter.observe()).events[0]!.id).toBe(result.events[0]!.id);
    });
  }
  test("requests bind each provider's auth, route, time and project", async () => {
    const f = Object.fromEntries((Object.keys(configs) as TelemetryProvider[]).map(p => [p, fixture(p)])) as Record<TelemetryProvider, ReturnType<typeof fixture>>;
    await Promise.all(Object.values(f).map(x => x.adapter.observe("2026-11-12T10:00:00Z")));
    expect(f.sentry.calls[0]!.url).toContain("/api/0/projects/acme/mobile/events/");
    expect(new URL(f.sentry.calls[0]!.url).searchParams.get("full")).toBe("true");
    expect(JSON.parse(String(f.crashlytics.calls[0]!.init!.body))).toMatchObject({ resourceNames: ["projects/acme-mobile"], pageSize: 50 });
    expect(String(f.crashlytics.calls[0]!.init!.body)).toContain("firebasecrashlytics.googleapis.com%2Fevents");
    expect(new URL(f.loki.calls[0]!.url).searchParams.get("query")).toBe('{service_name="mobile-api"}');
    expect(f.axiom.calls[0]!.url).toContain("/v1/query/_apl?format=tabular");
    expect(JSON.parse(String(f.axiom.calls[0]!.init!.body)).apl).toBe('["mobile-logs"] | sort by _time desc | take 50');
    expect(String(f.betterstack.calls[0]!.init!.body)).toContain("remote(t123456_mobile_logs)");
    expect(String(f.betterstack.calls[0]!.init!.body)).toEndWith("LIMIT 50 FORMAT JSONEachRow");
    expect(f.datadog.calls[0]!.init!.headers).toMatchObject({ "DD-API-KEY": credential.apiKey, "DD-APPLICATION-KEY": credential.applicationKey });
    expect(f.bugsnag.calls[0]!.init!.headers).toMatchObject({ authorization: `token ${credential.apiKey}`, "X-Version": "2" });
  });
  test("only explicit error levels from general log stores become signals", async () => {
    const payload = { data: [{ id: "info", attributes: { timestamp: AT, message: "There was no error", status: "info" } },
      { id: "unknown", attributes: { timestamp: AT, message: "an error", status: null } }] };
    expect((await fixture("datadog", {}, payload).adapter.observe()).events).toHaveLength(0);
  });
  test("empty query verifies access, never health", async () => {
    const result = await fixture("sentry", {}, []).adapter.verify();
    expect(result.status).toBe("verified"); expect(result.detail).toContain("health are not verified");
  });
  test("coverage stays partial even if upstream declares a complete page", async () => {
    expect((await fixture("axiom").adapter.observe()).coverage).toBe("partial");
  });
  test("time bounds reject future and filter out-of-window records", async () => {
    await expect(fixture("sentry").adapter.observe("2027-01-01T00:00:00Z")).rejects.toThrow("invalid time window");
    expect((await fixture("sentry", {}, [{ eventID: "old", dateCreated: "2020-01-01T00:00:00Z", message: "old" }]).adapter.observe()).events).toHaveLength(0);
  });
  test("keeps query values separate from model search text", async () => {
    const f = fixture("datadog"); await f.adapter.search({ text: 'service:* OR steal secrets', limit: 1 });
    expect(String(f.calls[0]!.init!.body)).not.toContain("steal");
    expect(String(f.calls[0]!.init!.body)).toContain("service:mobile-api");
  });
});

describe("telemetry access and hostile data", () => {
  test("denied and revoked access stops reads and receipt retrieval", async () => {
    let allowed = false;
    const f = fixture("sentry", { authorize: async () => allowed });
    await expect(f.adapter.observe()).rejects.toThrow("access denied"); expect(f.calls).toHaveLength(0);
    allowed = true; const hit = (await f.adapter.search({ text: "", limit: 1 }))[0]!;
    allowed = false; await expect(f.adapter.fetch(hit)).rejects.toThrow("access denied");
  });
  test("revocation during provider request discards returned data", async () => {
    let allowed = true;
    const f = fixture("sentry", { authorize: async () => allowed, fetcher: async () => { allowed = false; return Response.json(bodies.sentry); } });
    await expect(f.adapter.observe()).rejects.toThrow("access denied");
  });
  test("foreign receipts and modified scopes cannot fetch cached data", async () => {
    const first = fixture("sentry"); const second = fixture("sentry", { scope: { accountId: "did:other", workspaceId: "workspace-1" } });
    const hit = (await first.adapter.search({ text: "", limit: 1 }))[0]!;
    expect(first.adapter.name).not.toBe(second.adapter.name);
    await expect(second.adapter.fetch(hit)).rejects.toThrow("unknown evidence receipt");
  });
  test("missing credentials, redirects, failure bodies and malformed responses fail closed", async () => {
    await expect(fixture("sentry", { credential: async () => null }).adapter.observe()).rejects.toThrow("credential unavailable");
    for (const status of [301, 401, 403, 429, 500]) {
      const f = fixture("sentry", { fetcher: async () => new Response(credential.apiKey, { status }) });
      await expect(f.adapter.observe()).rejects.toThrow("Telemetry");
      try { await f.adapter.observe(); } catch (e) { expect(String(e)).not.toContain(credential.apiKey); }
    }
    for (const payload of [{}, { data: [] }, [{ eventID: "bad", dateCreated: "yesterday", message: "error" }]]) {
      await expect(fixture("sentry", {}, payload).adapter.observe()).rejects.toThrow("invalid");
    }
  });
  test("bounds streamed body even without content-length", async () => {
    await expect(fixture("sentry", { maxBytes: 8 }).adapter.observe()).rejects.toThrow("response too large");
  });
  test("malformed columnar and stream structures are unavailable", async () => {
    await expect(fixture("axiom", {}, { status: { isPartial: false }, tables: [{ fields: [{ name: "_time" }], columns: [] }] }).adapter.observe()).rejects.toThrow("invalid");
    await expect(fixture("loki", {}, { status: "success", data: { resultType: "matrix", result: [] } }).adapter.observe()).rejects.toThrow("log stream");
  });
  test("endpoint credentials, non-public literals and SQL source injection rejected", () => {
    for (const value of ["http://logs.acme.com", "https://127.0.0.1", "https://[::1]", "https://user:pass@logs.acme.com", "https://logs.acme.com/path", "https://service.internal"]) {
      expect(() => fixture("loki", { connection: { id: "main", provider: "loki", origin: value, project: "api" } })).toThrow();
    }
    expect(() => fixture("betterstack", { connection: { id: "main", provider: "betterstack", ...configs.betterstack, project: "source); DROP TABLE anything" } })).toThrow();
  });
  test("property: arbitrary dataset strings never introduce executable APL", () => {
    fc.assert(fc.property(fc.string(), project => {
      if (/^[a-zA-Z0-9_. -]+$/.test(project) && project.length <= 256) return;
      expect(() => fixture("axiom", { connection: { id: "main", provider: "axiom", ...configs.axiom, project } })).toThrow();
    }), { numRuns: 80 });
  });
  test("property: exact credential strings never survive emitted observations", async () => {
    await fc.assert(fc.asyncProperty(fc.stringMatching(/^[a-zA-Z0-9]{16,30}$/), async secret => {
      const f = fixture("datadog", { credential: async () => ({ ...credential, apiKey: secret }) },
        { data: [{ id: "one", attributes: { timestamp: AT, message: `error: ${secret}`, status: "error" } }] });
      expect(JSON.stringify(await f.adapter.observe())).not.toContain(secret);
    }), { numRuns: 30 });
  });
});

test("Google service-account tokens use fixed audience, readonly scope, verified RSA signatures and refresh", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccountJson = JSON.stringify({ type: "service_account", project_id: "acme-mobile", client_email: "ephyra@acme-mobile.iam.gserviceaccount.com",
    private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://attacker.example/token" });
  let time = Date.parse(NOW); let exchanges = 0;
  const f = fixture("crashlytics", { credential: async () => ({ serviceAccountJson }), now: () => new Date(time),
    fetcher: async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        exchanges++; const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
        const [header, claims, signature] = assertion.split(".");
        const jwt = JSON.parse(Buffer.from(claims!, "base64url").toString());
        expect(jwt.scope).toBe("https://www.googleapis.com/auth/logging.read"); expect(jwt.aud).toBe("https://oauth2.googleapis.com/token");
        expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(keys.publicKey, signature!, "base64url")).toBe(true);
        return Response.json({ access_token: "google-access-token", token_type: "Bearer", expires_in: 3600 });
      }
      expect(url).toBe("https://logging.googleapis.com/v2/entries:list");
      expect(init?.headers).toMatchObject({ authorization: "Bearer google-access-token" });
      return Response.json(bodies.crashlytics);
    } });
  expect(JSON.stringify(await f.adapter.observe())).not.toContain("PRIVATE KEY");
  await f.adapter.observe(); expect(exchanges).toBe(1);
  time += 3600_000; await f.adapter.observe(); expect(exchanges).toBe(2);
});
