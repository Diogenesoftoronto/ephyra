import { describe, expect, test } from "bun:test";
import {
  catalogProvidersFor,
  createModelCatalogLoader,
  MODEL_CATALOG_URL,
  ModelCatalogUnavailable,
  normalizeCatalogBaseUrl,
  parseModelCatalog,
  searchCatalogModels,
  type ModelCatalog,
} from "./model-catalog.ts";

const data = {
  openai: {
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    models: {
      exact: {
        id: "exact-model-v2",
        name: "A useful model",
        limit: { context: 100_000, output: 8000 },
        cost: { input: 1.5, output: 6 },
        reasoning: true,
        tool_call: true,
      },
      unknown: { name: "Sparse metadata" },
      audio: { name: "Audio only", modalities: { output: ["audio"] } },
      malformed: { name: "Bad price", cost: { input: -1 } },
    },
  },
  anthropic: { npm: "@ai-sdk/anthropic", models: { "exact-claude": { tool_call: false } } },
  compatible: {
    name: "Compatible fixture",
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.example.com/v1/",
    models: { "provider/model": { cost: { input: 0, output: 0, tiers: [{}] } } },
  },
  anthropicClone: { npm: "@ai-sdk/anthropic", api: "https://api.example.com/v1", models: { wrong: {} } },
  google: { npm: "@ai-sdk/google", models: { wrong: {} } },
};
function fixture(): ModelCatalog {
  return { providers: parseModelCatalog(data), fetchedAt: "2026-01-01T00:00:00.000Z", source: MODEL_CATALOG_URL };
}
const jsonResponse = () => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

describe("model catalog metadata", () => {
  test("preserves exact IDs, published costs and unknowns", () => {
    const models = catalogProvidersFor(fixture(), "openai")[0]!.models;
    expect(models.find((model) => model.id === "exact-model-v2")).toMatchObject({
      name: "A useful model",
      contextTokens: 100_000,
      outputTokens: 8000,
      inputUsdPerMillion: 1.5,
      outputUsdPerMillion: 6,
      tools: true,
      reasoning: true,
    });
    expect(models.find((model) => model.id === "unknown")).toMatchObject({
      contextTokens: null,
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
      tools: null,
      reasoning: null,
    });
    expect(models.some((model) => model.id === "audio" || model.id === "malformed")).toBe(false);
    expect(catalogProvidersFor(fixture(), "compatible", "https://api.example.com/v1")[0]!.models[0]).toMatchObject({
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      tieredPricing: true,
    });
  });

  test("matches compatible endpoints exactly and excludes different wire adapters", () => {
    expect(
      catalogProvidersFor(fixture(), "compatible", "https://api.example.com/v1/").map((provider) => provider.id),
    ).toEqual(["compatible"]);
    for (const base of [
      "https://api.example.com",
      "https://api.example.com/v2",
      "https://other.example.com/v1",
      "https://api.example.com.evil/v1",
      "",
    ]) {
      expect(catalogProvidersFor(fixture(), "compatible", base)).toEqual([]);
    }
    expect(catalogProvidersFor(fixture(), "notorganic")).toEqual([]);
    expect(
      catalogProvidersFor(fixture(), "anthropic", "https://api.anthropic.com/v1/").map((provider) => provider.id),
    ).toEqual(["anthropic"]);
    expect(catalogProvidersFor(fixture(), "anthropic", "https://custom.example.com/v1")).toEqual([]);
    expect(
      catalogProvidersFor(fixture(), "anthropic", "https://api.example.com/v1").map((provider) => provider.id),
    ).toEqual(["anthropicClone"]);
    expect(normalizeCatalogBaseUrl("https://user:secret@api.example.com/v1")).toBeNull();
    expect(normalizeCatalogBaseUrl("https://api.example.com/v1?token=secret")).toBeNull();
  });

  test("searches names and IDs without changing or selecting an ID", () => {
    const providers = catalogProvidersFor(fixture(), "openai");
    expect(searchCatalogModels(providers, "useful").map((model) => model.id)).toEqual(["exact-model-v2"]);
    expect(searchCatalogModels(providers, "EXACT-MODEL").map((model) => model.id)).toEqual(["exact-model-v2"]);
    expect(searchCatalogModels(providers, "exact-model-v3")).toEqual([]);
  });

  test("rejects malformed and overlarge catalogs", () => {
    for (const value of [
      null,
      [],
      "invalid",
      {},
      { malicious: { npm: "@ai-sdk/openai", models: { bad: { id: "secret\nheader" } } } },
      Object.fromEntries(Array.from({ length: 513 }, (_, i) => [String(i), {}])),
    ]) {
      expect(() => parseModelCatalog(value)).toThrow(ModelCatalogUnavailable);
    }
  });
});

describe("public catalog loading", () => {
  test("sends no account credentials, caches and coalesces concurrent readers", async () => {
    let requests = 0;
    let now = 0;
    const load = createModelCatalogLoader({
      now: () => now,
      cacheMs: 10,
      fetcher: (async (url, options) => {
        requests++;
        expect(url).toBe(MODEL_CATALOG_URL);
        expect(options).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
        expect(new Headers(options?.headers).has("authorization")).toBe(false);
        expect(new Headers(options?.headers).has("cookie")).toBe(false);
        return jsonResponse();
      }) as typeof fetch,
    });
    const results = await Promise.all([load(), load()]);
    expect(results[0]).toBe(results[1]);
    await load();
    expect(requests).toBe(1);
    now = 11;
    await load();
    expect(requests).toBe(2);
  });

  test("bounds announced and streamed bytes", async () => {
    for (const response of [
      new Response("{}", { headers: { "content-length": "1000" } }),
      new Response(" ".repeat(1000)),
    ]) {
      const load = createModelCatalogLoader({ maxBytes: 10, fetcher: (async () => response) as typeof fetch });
      await expect(load()).rejects.toBeInstanceOf(ModelCatalogUnavailable);
    }
  });

  test("fails safely on invalid JSON, HTTP failure, and timeout; failures can be retried", async () => {
    for (const response of [new Response("broken"), new Response("private error details", { status: 503 })]) {
      await expect(
        createModelCatalogLoader({ fetcher: (async () => response) as typeof fetch })(),
      ).rejects.toMatchObject({
        message: "The public model catalog is unavailable. You can still enter an exact model ID.",
      });
    }
    let calls = 0;
    const load = createModelCatalogLoader({
      timeoutMs: 5,
      fetcher: (async () => {
        calls++;
        return calls === 1 ? await new Promise<Response>(() => {}) : jsonResponse();
      }) as typeof fetch,
    });
    await expect(load()).rejects.toBeInstanceOf(ModelCatalogUnavailable);
    expect((await load()).providers.length).toBe(4);
  });
});
