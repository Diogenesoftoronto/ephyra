import { z } from "zod";

export const MODEL_CATALOG_URL = "https://models.dev/api.json";
export type CatalogSelection = "notorganic" | "openai" | "anthropic" | "compatible";
export type CatalogModel = {
  id: string;
  name: string;
  contextTokens: number | null;
  outputTokens: number | null;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  tieredPricing: boolean;
  tools: boolean | null;
  reasoning: boolean | null;
};
export type CatalogProvider = {
  id: string;
  name: string;
  api?: string;
  adapter: "openai" | "anthropic" | "openai-compatible";
  models: CatalogModel[];
};
export type ModelCatalog = { providers: CatalogProvider[]; fetchedAt: string; source: typeof MODEL_CATALOG_URL };

export class ModelCatalogUnavailable extends Error {
  constructor() {
    super("The public model catalog is unavailable. You can still enter an exact model ID.");
    this.name = "ModelCatalogUnavailable";
  }
}

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const text = z.string().min(1).max(300);
const number = z.number().finite().nonnegative().nullable().optional();
const modelSchema = z.object({
  id: id.optional(),
  name: text.optional(),
  tool_call: z.boolean().nullable().optional(),
  reasoning: z.boolean().nullable().optional(),
  limit: z.object({ context: number, output: number }).nullable().optional(),
  cost: z
    .object({
      input: number,
      output: number,
      tiers: z.array(z.unknown()).max(100).optional(),
      context_over_200k: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  modalities: z.object({ output: z.array(z.string().max(100)).max(32).optional() }).optional(),
});
const providerSchema = z.object({
  id: id.optional(),
  name: text.optional(),
  npm: z.string().max(200),
  api: z.string().max(2048).optional(),
  models: z.record(z.string(), z.unknown()),
});

/** Public metadata only. Missing prices/capabilities remain unknown; they never become zero/false. */
export function parseModelCatalog(value: unknown): CatalogProvider[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelCatalogUnavailable();
  const entries = Object.entries(value);
  if (entries.length > 512) throw new ModelCatalogUnavailable();
  const providers: CatalogProvider[] = [];
  let count = 0;
  for (const [key, raw] of entries) {
    const parsed = providerSchema.safeParse(raw);
    if (!parsed.success) continue;
    const provider = parsed.data;
    const providerId = id.safeParse(provider.id ?? key);
    if (!providerId.success) continue;
    const nativeOpenAi = providerId.data === "openai" && provider.npm === "@ai-sdk/openai";
    const anthropic = provider.npm === "@ai-sdk/anthropic";
    const compatible = ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@openrouter/ai-sdk-provider"].includes(
      provider.npm,
    );
    if (!nativeOpenAi && !anthropic && !compatible) continue;
    const modelEntries = Object.entries(provider.models);
    count += modelEntries.length;
    if (modelEntries.length > 5000 || count > 40_000) throw new ModelCatalogUnavailable();
    const models: CatalogModel[] = [];
    const seen = new Set<string>();
    for (const [modelKey, rawModel] of modelEntries) {
      const result = modelSchema.safeParse(rawModel);
      if (!result.success) continue;
      const model = result.data;
      const modelId = id.safeParse(model.id ?? modelKey);
      if (!modelId.success || seen.has(modelId.data)) continue;
      // This picker configures a text agent; explicitly non-text models would be misleading suggestions.
      if (model.modalities?.output && !model.modalities.output.includes("text")) continue;
      seen.add(modelId.data);
      models.push({
        id: modelId.data,
        name: model.name ?? modelId.data,
        contextTokens: model.limit?.context ?? null,
        outputTokens: model.limit?.output ?? null,
        inputUsdPerMillion: model.cost?.input ?? null,
        outputUsdPerMillion: model.cost?.output ?? null,
        tieredPricing: Boolean(model.cost?.tiers?.length || model.cost?.context_over_200k),
        tools: model.tool_call ?? null,
        reasoning: model.reasoning ?? null,
      });
    }
    if (!models.length) continue;
    providers.push({
      id: providerId.data,
      name: provider.name ?? providerId.data,
      ...(normalizeCatalogBaseUrl(provider.api) ? { api: normalizeCatalogBaseUrl(provider.api)! } : {}),
      adapter: nativeOpenAi ? "openai" : anthropic ? "anthropic" : "openai-compatible",
      models: models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    });
  }
  if (!providers.length) throw new ModelCatalogUnavailable();
  return providers.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function normalizeCatalogBaseUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** A catalog is not an account model list. Unknown compatible endpoints and hosted accounts stay manual. */
export function catalogProvidersFor(
  catalog: ModelCatalog,
  selection: CatalogSelection,
  baseUrl?: string,
): CatalogProvider[] {
  if (selection === "notorganic") return [];
  if (selection === "openai")
    return catalog.providers.filter((provider) => provider.id === "openai" && provider.adapter === "openai");
  if (selection === "anthropic") {
    const api = baseUrl?.trim() ? normalizeCatalogBaseUrl(baseUrl) : "https://api.anthropic.com/v1";
    if (!api) return [];
    return catalog.providers.filter(
      (provider) =>
        provider.adapter === "anthropic" &&
        (api === "https://api.anthropic.com/v1" ? provider.id === "anthropic" : provider.api === api),
    );
  }
  const api = normalizeCatalogBaseUrl(baseUrl);
  if (!api) return [];
  return catalog.providers.filter((provider) => provider.adapter === "openai-compatible" && provider.api === api);
}

export type CatalogChoice = CatalogModel & { providerId: string; providerName: string };
export function searchCatalogModels(providers: CatalogProvider[], query: string): CatalogChoice[] {
  const needle = query.trim().toLocaleLowerCase();
  return providers.flatMap((provider) =>
    provider.models
      .filter(
        (model) =>
          !needle || model.id.toLocaleLowerCase().includes(needle) || model.name.toLocaleLowerCase().includes(needle),
      )
      .map((model) => ({ ...model, providerId: provider.id, providerName: provider.name })),
  );
}

export type CatalogLoaderOptions = {
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  cacheMs?: number;
};

/** Cache contains public metadata in memory only. Account credentials and provider URLs never enter this request. */
export function createModelCatalogLoader(options: CatalogLoaderOptions = {}) {
  let cached: { catalog: ModelCatalog; expires: number } | undefined;
  let pending: Promise<ModelCatalog> | undefined;
  return (): Promise<ModelCatalog> => {
    const now = options.now ?? Date.now;
    if (cached && cached.expires > now()) return Promise.resolve(cached.catalog);
    if (pending) return pending;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const limit = options.maxBytes ?? 12_000_000;
    const operation = async () => {
      const response = await (options.fetcher ?? fetch)(MODEL_CATALOG_URL, {
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (
        !response.ok ||
        response.redirected ||
        Number(response.headers.get("content-length")) > limit ||
        !response.body
      )
        throw new ModelCatalogUnavailable();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw new ModelCatalogUnavailable();
          if (done) break;
          size += value.byteLength;
          if (size > limit) {
            await reader.cancel();
            throw new ModelCatalogUnavailable();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const providers = parseModelCatalog(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (controller.signal.aborted) throw new ModelCatalogUnavailable();
      const catalog: ModelCatalog = { providers, fetchedAt: new Date(now()).toISOString(), source: MODEL_CATALOG_URL };
      cached = { catalog, expires: now() + (options.cacheMs ?? 10 * 60_000) };
      return catalog;
    };
    pending = Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ModelCatalogUnavailable());
        }, options.timeoutMs ?? 8000);
      }),
    ])
      .catch(() => {
        throw new ModelCatalogUnavailable();
      })
      .finally(() => {
        clearTimeout(timer);
        pending = undefined;
      });
    return pending;
  };
}

export const loadModelCatalog = createModelCatalogLoader();
