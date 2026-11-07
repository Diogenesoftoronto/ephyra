import type { InboxItem, Trail, TrailEvent } from "@ephyra/core";

export class ApiError extends Error {
	constructor(readonly status: number) {
		super(
			status === 409
				? "Stale decision; refresh before retrying"
				: `API request failed (${status})`,
		);
	}
}
export type Detail = { trail: Trail; events: TrailEvent[] };
export class Client {
	constructor(
		readonly url: string,
		readonly token: string,
		readonly fetcher: typeof fetch = fetch,
		readonly principal = "",
	) {}
	async request<T>(path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			"X-Ephyra-Principal": this.principal,
		};
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			headers["Idempotency-Key"] = crypto.randomUUID();
		}
		const res = await this.fetcher(new URL(path, this.url), {
			method: body === undefined ? "GET" : "POST",
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!res.ok) throw new ApiError(res.status);
		return (await res.json()) as T;
	}
	health() {
		return this.request<unknown>("/healthz");
	}
	inbox() {
		return this.request<InboxItem[]>("/v1/inbox");
	}
	trails(state?: string) {
		return this.request<Trail[]>(
			`/v1/trails${state ? `?state=${encodeURIComponent(state)}` : ""}`,
		);
	}
	show(id: string) {
		return this.request<Detail>(`/v1/trails/${encodeURIComponent(id)}`);
	}
	action(id: string, action: string, body: unknown = {}) {
		return this.request<unknown>(
			`/v1/trails/${encodeURIComponent(id)}/${action}`,
			body,
		);
	}
	spend(id: string, verdict: string, note?: string) {
		return this.request<unknown>(`/v1/spend/${encodeURIComponent(id)}/decide`, {
			verdict,
			...(note ? { note } : {}),
		});
	}
}
