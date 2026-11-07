import { ReconciliationRequired } from "@ephyra/core";

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`Model request failed with HTTP ${status}`);
    this.name = "HttpError";
  }
}

export interface HttpOptions {
  key: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Retry only explicit rate-limit or overload responses with a valid Retry-After. */
export async function postJson(url: string, body: unknown, headers: Record<string, string> | (() => Promise<Record<string, string>>), options: HttpOptions): Promise<unknown> {
  const fetcher = options.fetch ?? fetch;
  const retries = Math.min(3, Math.max(0, options.retries ?? 2));
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    if (options.signal?.aborted) throw options.signal.reason;
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    const requestHeaders = typeof headers === "function" ? await headers() : headers;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json", "Idempotency-Key": options.key, ...Object.fromEntries(new Headers(requestHeaders)) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new ReconciliationRequired(options.key, "Model request outcome is unknown");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
    if (response.ok) return response.json();
    const value = response.headers.get("Retry-After");
    const seconds = value === null ? NaN : Number(value);
    const dateDelay = value === null ? NaN : Date.parse(value) - Date.now();
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Math.max(0, dateDelay);
    if ([429, 503, 529].includes(response.status) && attempt < retries && Number.isFinite(delay) && delay <= 30_000) {
      await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
      continue;
    }
    throw new HttpError(response.status);
  }
}
