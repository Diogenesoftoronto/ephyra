import { ActivityItem, Draft, PolicyDoc, UsageEntry, UsageSummary } from "@ephyra/core";
import { z } from "zod";

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(status === 409 ? "This item changed. Refresh before trying again." : `API request failed (${status})`);
  }
}

/** An interrupted mutation may have succeeded. Reconcile its operation key before any retry. */
export class UnknownWriteOutcome extends Error {
  constructor(readonly operationKey: string) {
    super("The write outcome is unknown. Reconcile before retrying.");
  }
}

export class ConsoleClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  async request<T>(path: string, schema: z.ZodType<T>, options?: {
    method: "POST" | "PUT"; body: unknown; operationKey: string;
  }): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (options) {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = options.operationKey;
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
        method: options?.method ?? "GET", headers,
        ...(options ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch {
      if (options) throw new UnknownWriteOutcome(options.operationKey);
      throw new Error("API connection failed");
    }
    if (!response.ok) throw new ApiError(response.status);
    return schema.parse(await response.json());
  }

  activity() { return this.request("/v1/activity", z.array(ActivityItem)); }
  usage() { return this.request("/v1/usage", UsageSummary); }
  entries() { return this.request("/v1/usage/entries", z.object({ entries: z.array(UsageEntry), cursor: z.string().optional() })); }
  docs() { return this.request("/v1/docs", z.array(PolicyDoc)); }
  drafts() { return this.request("/v1/drafts", z.array(Draft)); }
  draft(id: string) { return this.request(`/v1/drafts/${encodeURIComponent(id)}`, Draft); }
  createDraft(path: string, operationKey: string) {
    return this.request("/v1/drafts", Draft, { method: "POST", body: { path }, operationKey });
  }
  updateContent(id: string, content: string, baseDigest: string, operationKey: string) {
    return this.request(`/v1/drafts/${encodeURIComponent(id)}/content`, Draft, {
      method: "PUT", body: { content, baseDigest }, operationKey,
    });
  }
}
