import {
	shortId,
	type ActivityItem,
	type AreaSketch,
	type AgentRun,
	type AgentRunEvent,
	type InboxItem,
	type InvestigationQuestion,
	type PolicyActivationReceipt,
	type SetupRun,
	type Trail,
	type TrailEvent,
	type UsageSummary,
} from "@ephyra/core";

/** What a status code means for the person at the terminal, and what to do about it. Never a response body. */
const EXPLAIN: Record<number, string> = {
	401: "Not signed in, or the session expired: run `ephyra login <server-url>`",
	403: "Read-only here: changing quests needs a signed-in approver (`ephyra whoami`)",
	404: "Not found: check the id with `ephyra quests`",
	400: "The server refused the request as invalid",
	409: "Stale decision; refresh before retrying",
	422: "The server cannot do that as it is configured",
	501: "This server does not support that yet",
	503: "The server is unavailable: `ephyra status` shows its health",
};
export class ApiError extends Error {
	constructor(readonly status: number) {
		super(EXPLAIN[status] ?? `API request failed (${status})`);
	}
}
/** An agent registration the signed-in owner approved. */
export type AgentAccess = {
	id: string;
	repository: { url: string; branch: string };
	workspaceId: string;
	scopes: string[];
	createdAt: string;
	expiresAt: string;
	revokedAt: string | null;
};
export type Me = { principal: string; kind: string; approver: boolean };
export type PolicyDocSummary = { path: string; kind: string; digest: string; warnings: string[] };
/** A policy document as the server holds it. `sketches` (the application map) comes with the autonomy document when it parses. */
export type PolicyDocument = PolicyDocSummary & { content: string; sketches?: AreaSketch[] };
/** A draft of one policy document. Edits go here; publishing writes it and activating puts it into effect. */
export type PolicyDraft = {
	id: string;
	path: string;
	baseDigest: string;
	content: string;
	warnings: string[];
	status: "open" | "published" | "discarded";
	updatedAt: string;
	published?: { ref: string; commit: string; by: string; at: string };
	sketches?: AreaSketch[];
};
export type Detail = { trail: Trail; events: TrailEvent[] };
export class Client {
	constructor(
		readonly url: string,
		readonly token: string,
		readonly fetcher: typeof fetch = fetch,
		readonly principal = "",
	) {}
	async request<T>(
		path: string,
		body?: unknown,
		extra: { method?: "DELETE" | "PUT"; headers?: Record<string, string> } = {},
	): Promise<T> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			...extra.headers,
		};
		// Only the service token names its principal; a signed-in session's principal is its Not Organic DID.
		if (this.principal) headers["X-Ephyra-Principal"] = this.principal;
		const write = body !== undefined || extra.method === "DELETE";
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (write) headers["Idempotency-Key"] = crypto.randomUUID();
		let res: Response;
		try {
			res = await this.fetcher(new URL(path, this.url), {
				method: extra.method ?? (body === undefined ? "GET" : "POST"),
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new Error(
				write
					? "API write outcome unknown; reconcile before retrying"
					: "API connection failed",
			);
		}
		if (!res.ok) throw new ApiError(res.status);
		const text = await res.text();
		return (text ? JSON.parse(text) : null) as T;
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
	/** A full quest id from either a full id or the short one the lists show (T-1a2b). */
	async resolve(id: string): Promise<string> {
		if (!/^T-/i.test(id)) return id;
		const matches = (await this.trails()).filter(
			(t) => shortId(t.id).toLowerCase() === id.toLowerCase(),
		);
		if (matches.length !== 1)
			throw new Error(
				matches.length
					? "Ambiguous short ID; use the full id from `ephyra quests --json`"
					: "Quest not found. `ephyra quests` lists them.",
			);
		return matches[0]!.id;
	}
	async show(id: string) {
		return this.request<Detail>(
			`/v1/trails/${encodeURIComponent(await this.resolve(id))}`,
		);
	}
	/** A trail and its events, by full id. */
	detail(id: string) {
		return this.request<Detail>(`/v1/trails/${encodeURIComponent(id)}`);
	}
	/** A file from the trail's journal (hypothesis.md, plan.md, …), or null when the journal doesn't have it. */
	async file(id: string, path: string): Promise<string | null> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
		};
		if (this.principal) headers["X-Ephyra-Principal"] = this.principal;
		let res: Response;
		try {
			res = await this.fetcher(
				new URL(
					`/v1/trails/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
					this.url,
				),
				{ method: "GET", headers },
			);
		} catch {
			throw new Error("API connection failed");
		}
		if (res.status === 404) return null;
		if (!res.ok) throw new ApiError(res.status);
		return res.text();
	}
	action(id: string, action: string, body: unknown = {}) {
		return this.request<unknown>(
			`/v1/trails/${encodeURIComponent(id)}/${action}`,
			body,
		);
	}
	me() {
		return this.request<Me>("/v1/me");
	}
	runs(filter: { trail?: string; status?: string; limit?: number } = {}) {
		const query = new URLSearchParams();
		if (filter.trail) query.set("trail", filter.trail);
		if (filter.status) query.set("status", filter.status);
		if (filter.limit) query.set("limit", String(filter.limit));
		const q = query.toString();
		return this.request<AgentRun[]>(`/v1/runs${q ? `?${q}` : ""}`);
	}
	run(id: string) {
		return this.request<AgentRun>(`/v1/runs/${encodeURIComponent(id)}`);
	}
	/** A page of a run's events after `after` (a sequence number); an empty page means it has caught up. */
	runEvents(id: string, after?: number) {
		return this.request<AgentRunEvent[]>(
			`/v1/runs/${encodeURIComponent(id)}/events${after === undefined ? "" : `?after=${after}`}`,
		);
	}
	/** The server's default window is the last seven days; `days` asks for a longer or shorter one. */
	usage(days?: number, now = new Date()) {
		const from = days
			? `?from=${encodeURIComponent(new Date(now.getTime() - days * 86_400_000).toISOString())}`
			: "";
		return this.request<UsageSummary>(`/v1/usage${from}`);
	}
	activity(limit?: number) {
		return this.request<ActivityItem[]>(
			`/v1/activity${limit ? `?limit=${limit}` : ""}`,
		);
	}
	policyActive() {
		return this.request<PolicyActivationReceipt | null>("/v1/policy/active");
	}
	policyDocs() {
		return this.request<PolicyDocument[]>("/v1/docs");
	}
	policyDoc(path: string) {
		return this.request<PolicyDocument>(`/v1/docs/${path.split("/").map(encodeURIComponent).join("/")}`);
	}
	drafts(status?: PolicyDraft["status"]) {
		return this.request<PolicyDraft[]>(`/v1/drafts${status ? `?status=${status}` : ""}`);
	}
	createDraft(path: string) {
		return this.request<PolicyDraft>("/v1/drafts", { path });
	}
	/** Save the application map into a draft. The server renders it into the document. */
	setDraftSketches(draft: PolicyDraft, sketches: AreaSketch[]) {
		return this.request<PolicyDraft>(
			`/v1/drafts/${encodeURIComponent(draft.id)}/sketches`,
			{ sketches, baseDigest: draft.baseDigest },
			{ method: "PUT" },
		);
	}
	/** Save the raw document text into a draft. */
	setDraftContent(draft: PolicyDraft, content: string) {
		return this.request<PolicyDraft>(
			`/v1/drafts/${encodeURIComponent(draft.id)}/content`,
			{ content, baseDigest: draft.baseDigest },
			{ method: "PUT" },
		);
	}
	draftAction(id: string, action: "publish" | "discard") {
		return this.request<PolicyDraft>(`/v1/drafts/${encodeURIComponent(id)}/${action}`, {});
	}
	/** Put a published draft into effect. The server refuses when what was reviewed is no longer what would be activated. */
	activateDraft(id: string, expected: { expectedCommit: string; expectedDigest: string; expectedActive: string | null }) {
		return this.request<PolicyActivationReceipt>(`/v1/drafts/${encodeURIComponent(id)}/activate`, expected);
	}
	setup() {
		return this.request<SetupRun | null>("/v1/setup");
	}
	ops() {
		return this.request<unknown>("/v1/ops");
	}
	questions() {
		return this.request<InvestigationQuestion[]>("/v1/questions");
	}
	/** Answers bind to the workspace the question was asked in, so a changed workspace is refused rather than misfiled. */
	answer(question: InvestigationQuestion, text: string) {
		return this.request<unknown>(
			`/v1/questions/${encodeURIComponent(question.trailId)}/${question.id}/answer`,
			{ text },
			{ headers: { "X-Ephyra-Workspace": question.workspaceId } },
		);
	}
	agents() {
		return this.request<AgentAccess[]>("/v1/account/agents");
	}
	revokeAgent(id: string) {
		return this.request<{ revoked: boolean }>(
			`/v1/account/agents/${encodeURIComponent(id)}`,
			undefined,
			{ method: "DELETE" },
		);
	}
	spend(id: string, verdict: string, note?: string) {
		return this.request<unknown>(`/v1/spend/${encodeURIComponent(id)}/decide`, {
			verdict,
			...(note ? { note } : {}),
		});
	}
}
