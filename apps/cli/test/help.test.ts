import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import fc from "fast-check";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMMANDS, DOCS_TOPICS, UsageError, ago, agentsView, commandHelpView, doctor, doctorView, docsTopic, docsUrl, findCommand,
	handoffBrief, helpView, main, plain, policyView, questionsView, repoFacts, runView, runsView, setupView, suggest, usageView,
	withoutCredentials, Client, type Check, type RepoFacts,
} from "../src/index";

const now = new Date("2026-11-11T12:00:00Z");
const text = (lines: Parameters<typeof plain>[0]) => plain(lines);
const TRAIL = "019cc100-0000-7000-8000-000000000001";

// ───── A fake server: main() runs against it exactly as it does against a real one ─────
let dir: string;
let saved: Record<string, string | undefined>;
let requests: { method: string; path: string; body: unknown; headers: Headers }[];
let out: Mock<typeof console.log>;
let transport: Mock<typeof fetch>;
let routes: Record<string, (body: unknown) => unknown>;
const ENV = ["EPHYRA_CREDENTIALS", "EPHYRA_URL", "EPHYRA_API_TOKEN", "EPHYRA_PRINCIPAL", "EPHYRA_DOCS_URL", "NO_COLOR"];
const printed = () => out.mock.calls.map((call) => String(call[0])).join("\n");

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ephyra-help-"));
	saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
	Object.assign(process.env, { EPHYRA_CREDENTIALS: join(dir, "credentials.json"), EPHYRA_URL: "https://offline.example", EPHYRA_API_TOKEN: "test-token-0123456789", EPHYRA_PRINCIPAL: "tester" });
	delete process.env.EPHYRA_DOCS_URL;
	requests = [];
	routes = {};
	transport = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = url.pathname + url.search;
		requests.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
		const handler = routes[`${init?.method ?? "GET"} ${url.pathname}`];
		if (!handler) return Response.json({ error: "not found" }, { status: 404 });
		const value = handler(init?.body ? JSON.parse(String(init.body)) : undefined);
		return value instanceof Response ? value : Response.json(value);
	}) as typeof fetch);
	out = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
	transport.mockRestore();
	out.mockRestore();
	for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	process.exitCode = 0;
	await rm(dir, { recursive: true, force: true });
});

test("every command in the help table is one main() accepts, and every other word is refused with a suggestion", async () => {
	for (const command of COMMANDS) {
		expect(findCommand(command.name)).toBe(command);
		// Asking for help on a command never touches the network and never throws.
		await main([command.name, "--help"]);
		await main(["help", command.name]);
		for (const alias of command.aliases ?? []) expect(findCommand(alias)).toBe(command);
		if (command.docs) expect(Object.keys(DOCS_TOPICS)).toContain(command.docs);
	}
	expect(requests).toEqual([]);
	expect(printed()).toContain("ephyra decide <quest> <A|B|C> <approve|revise|reject> [-m note]");
	await expect(main(["aprove"])).rejects.toThrow(UsageError);
	await expect(main(["inbx"])).rejects.toThrow("Did you mean `ephyra inbox`?");
	await expect(main(["zzzzzzzz"])).rejects.toThrow("Unknown command “zzzzzzzz”.\nRun `ephyra help`");
	expect(suggest("quest")).toBe("quests");
	expect(suggest("statsu")).toBe("status");
	expect(suggest("completely-different")).toBeUndefined();
});

test("help fits the terminal at any width and names where to go next", () => {
	fc.assert(fc.property(fc.integer({ min: 20, max: 200 }), (w) => {
		const width = Math.max(40, w);
		for (const line of [...helpView(w), ...COMMANDS.flatMap((c) => commandHelpView(c, w))]) expect(line.reduce((n, seg) => n + [...seg.text].length, 0)).toBe(width);
	}), { numRuns: 25 });
	const help = text(helpView(100, {}));
	for (const command of COMMANDS) expect(help).toContain(command.name);
	expect(help).toContain("ephyra login <server-url>");
	expect(help).toContain("https://ephyra.quest/docs");
	expect(text(helpView(100, { EPHYRA_DOCS_URL: "https://docs.internal.example/" }))).toContain("https://docs.internal.example");
	expect(text(commandHelpView(findCommand("decide")!, 100, {}))).toContain("https://ephyra.quest/docs/reviewing");
});

test("bare ephyra, --version and docs work with no server and no sign-in", async () => {
	for (const key of ["EPHYRA_URL", "EPHYRA_API_TOKEN", "EPHYRA_PRINCIPAL"]) delete process.env[key];
	await main([]);
	expect(printed()).toContain("ephyra <command> [arguments] [--json]");
	await main(["--version"]);
	await main(["docs", "policy"]);
	await main(["docs", "stuck", "--json"]);
	expect(printed()).toContain("https://ephyra.quest/docs/policy");
	expect(JSON.parse(String(out.mock.calls.at(-1)![0]))).toEqual({ topic: "troubleshooting", url: "https://ephyra.quest/docs/troubleshooting", markdown: "https://ephyra.quest/docs/troubleshooting.md" });
	await expect(main(["docs", "nonsense"])).rejects.toThrow("No documentation page for “nonsense”");
	await expect(main(["quests"])).rejects.toThrow("Not signed in. Run `ephyra login <server-url>`");
	expect(requests).toEqual([]);
	expect(docsTopic(undefined)).toBe("index");
	expect(docsTopic("TUI")).toBe("terminal");
	expect(docsUrl("index", { EPHYRA_DOCS_URL: "https://d.example//" })).toBe("https://d.example");
	for (const topic of Object.keys(DOCS_TOPICS)) expect(docsTopic(topic)).toBe(topic);
});

test("a decision is bound to what is waiting in the inbox, and short ids resolve", async () => {
	const bound = { rev: 3, head: "a".repeat(40), proofDigest: "b".repeat(64) };
	routes["GET /v1/trails"] = () => [{ id: TRAIL }];
	routes["GET /v1/inbox"] = () => [{ trailId: TRAIL, kind: "checkpoint", checkpoint: "C", bound }, { trailId: TRAIL, kind: "spend", bound: { rev: 1 } }];
	routes[`POST /v1/trails/${TRAIL}/decide`] = () => ({ ok: true });
	const { shortId } = await import("@ephyra/core");
	await main(["decide", shortId(TRAIL), "C", "approve", "-m", "read it"]);
	const sent = requests.at(-1)!;
	expect(sent.path).toBe(`/v1/trails/${TRAIL}/decide`);
	expect(sent.body).toEqual({ checkpoint: "C", verdict: "approve", note: "read it", bound });
	expect(sent.headers.get("idempotency-key")).toBeTruthy();
	expect(printed()).toContain("C approved. The quest lands next");
	// Nothing waiting at that checkpoint: the server decides; no bound is invented.
	await main(["decide", TRAIL, "A", "revise", "-m", "wrong cause"]);
	expect(requests.at(-1)!.body).toEqual({ checkpoint: "A", verdict: "revise", note: "wrong cause" });
	for (const bad of [["decide", TRAIL], ["decide", TRAIL, "D", "approve"], ["decide", TRAIL, "A", "maybe"], ["comment", TRAIL], ["kill", TRAIL], ["show"], ["file", TRAIL], ["answer", "abc"], ["spend", TRAIL, "revise"]]) {
		await expect(main(bad), bad.join(" ")).rejects.toThrow(/^Usage: ephyra /);
	}
	routes["GET /v1/trails"] = () => [];
	await expect(main(["park", "T-ffff"])).rejects.toThrow("Quest not found");
});

test("a refusal says what it means, and an unanswered write is never reported as done", async () => {
	routes[`POST /v1/trails/${TRAIL}/land`] = () => Response.json({ error: "forbidden" }, { status: 403 });
	await expect(main(["land", TRAIL])).rejects.toThrow("Read-only here");
	routes[`POST /v1/trails/${TRAIL}/land`] = () => Response.json({ error: "stale" }, { status: 409 });
	await expect(main(["land", TRAIL])).rejects.toThrow("Stale decision; refresh before retrying");
	transport.mockImplementation((async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch);
	await expect(main(["land", TRAIL])).rejects.toThrow("API write outcome unknown; reconcile before retrying");
	await expect(main(["quests", "--json"])).rejects.toThrow("API connection failed");
	await expect(main(["agents", "revoke", "abc"])).rejects.toThrow("API write outcome unknown");
});

test("the read commands call their routes and print what the server recorded", async () => {
	const run = { id: "run-1", trailId: TRAIL, short: "T-1a2b", step: "patch", persona: "lappet", engine: "claude-code/claude-opus-5-5", executor: { kind: "railway" }, status: "running", startedAt: "2026-11-11T11:58:00Z" };
	routes["GET /v1/runs"] = () => [run];
	routes["GET /v1/runs/run-1"] = () => ({ ...run, status: "done", endedAt: "2026-11-11T11:59:30Z", usage: { tokens: 1200, costMicrousd: null } });
	let page = 0;
	routes["GET /v1/runs/run-1/events"] = () => (page++ === 0 ? [
		{ runId: "run-1", seq: 0, at: "2026-11-11T11:58:01Z", type: "message", text: "Reading the cart total." },
		{ runId: "run-1", seq: 1, at: "2026-11-11T11:58:05Z", type: "policy", policy: { decision: "reject", rule: "no-push", reason: "landing is not an agent action" }, tool: { callId: "c", name: "git push" } },
	] : []);
	routes["GET /v1/usage"] = () => ({ from: "2026-11-04T12:00:00Z", to: "2026-11-11T12:00:00Z", totals: { entries: 3, costMicrousd: 1_250_000, unknownCost: 1, tokens: 42_000, wallMs: 90_000, failed: 0, unavailable: 0 }, byPersona: [], byEngine: [], byTrail: [], byDay: [] });
	routes["GET /v1/policy/active"] = () => null;
	routes["GET /v1/docs"] = () => [{ path: "autonomy.md", kind: "autonomy", digest: "d".repeat(64), warnings: ["error: line 4: unknown risk"] }];
	routes["GET /v1/setup"] = () => null;
	routes["GET /v1/activity"] = () => [];
	routes["GET /v1/account/agents"] = () => [];
	routes["GET /v1/questions"] = () => [];
	routes["GET /v1/trails"] = () => [{ id: TRAIL }];
	routes[`GET /v1/trails/${TRAIL}/file`] = () => new Response("# Hypothesis\n", { headers: { "content-type": "text/markdown" } });

	await main(["runs", "--status", "running", "--quest", TRAIL]);
	expect(requests.at(-1)!.path).toBe(`/v1/runs?trail=${TRAIL}&status=running`);
	expect(printed()).toContain("claude-code/claude-opus-5-5");
	await main(["run", "run-1"]);
	expect(printed()).toContain("Reading the cart total.");
	expect(printed()).toContain("reject");
	expect(printed()).toContain("1.2k tokens · unknown");
	await main(["usage", "--days", "30"]);
	expect(requests.at(-1)!.path).toStartWith("/v1/usage?from=");
	expect(printed()).toContain("$1.25");
	expect(printed()).toContain("+1 with unknown cost");
	expect(printed()).toContain("lower bound");
	await main(["policy"]);
	expect(printed()).toContain("none activated");
	expect(printed()).toContain("1 error");
	await main(["setup"]);
	expect(printed()).toContain("No setup has been recorded");
	await main(["activity"]); await main(["agents"]); await main(["questions"]);
	expect(printed()).toContain("No coding agent has access.");
	await main(["file", TRAIL, "hypothesis.md"]);
	expect(requests.at(-1)!.path).toBe(`/v1/trails/${TRAIL}/file?path=hypothesis.md`);
	expect(printed()).toContain("# Hypothesis");
	await main(["open", TRAIL, "--json"]);
	expect(JSON.parse(String(out.mock.calls.at(-1)![0]))).toEqual({ url: `https://offline.example/app/#/inbox/${TRAIL}` });
	// Every one of those was a read, sent with the service token and its principal.
	expect(requests.every((r) => r.method === "GET" && r.headers.get("authorization") === "Bearer test-token-0123456789" && r.headers.get("x-ephyra-principal") === "tester")).toBe(true);
});

test("answering a question binds to its workspace, and revoking an agent is a DELETE", async () => {
	const id = "c".repeat(64);
	routes["GET /v1/questions"] = () => [{ id, trailId: TRAIL, workspaceId: "ws-9", status: "awaiting_answer", question: "Is tax included?", reason: "The total differs.", acceptance: "", createdAt: "2026-11-11T11:00:00Z" }];
	routes[`POST /v1/questions/${TRAIL}/${id}/answer`] = () => ({ ok: true });
	routes["DELETE /v1/account/agents/reg-1"] = () => ({ revoked: true });
	await main(["answer", "cccc", "-m", "Tax is included in CAD only."]);
	const sent = requests.at(-1)!;
	expect(sent.body).toEqual({ text: "Tax is included in CAD only." });
	expect(sent.headers.get("x-ephyra-workspace")).toBe("ws-9");
	await expect(main(["answer", "dddd", "-m", "x"])).rejects.toThrow("No open question has that id");
	await main(["agents", "revoke", "reg-1"]);
	expect(requests.at(-1)!.method).toBe("DELETE");
	expect(requests.at(-1)!.headers.get("idempotency-key")).toBeTruthy();
	expect(printed()).toContain("Access revoked.");
});

// ───── doctor and handoff ─────
const repo = (over: Partial<RepoFacts> = {}): RepoFacts => ({ isRepo: true, remote: "origin", url: "https://git.example/team/app.git", branch: "main", refspecs: { fetch: true, push: true }, templates: ["autonomy.md", "thresholds.yaml", "models.yaml"], ...over });
const server = (handlers: Record<string, () => unknown>) => (async (input: string | URL | Request) => {
	const handler = handlers[new URL(String(input)).pathname];
	if (!handler) return Response.json({}, { status: 404 });
	const value = handler();
	return value instanceof Response ? value : Response.json(value);
}) as typeof fetch;
const status = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.name, c.status]));

test("doctor reports what it checked, and what it could not check is skipped, never passed", async () => {
	const healthy = server({
		"/healthz": () => ({ ok: true, mode: "convex", version: "0.0.0" }), "/v1/me": () => ({ principal: "did:plc:x", kind: "human", approver: true }),
		"/v1/setup": () => ({ status: "ready", repository: { url: "https://git.example/team/app.git", branch: "main", head: "a".repeat(40) }, blockers: [] }), "/v1/inbox": () => [],
	});
	const url = "https://e.example";
	const good = await doctor({ env: {}, creds: null, client: new Client(url, "t", healthy, "p"), url, repo: repo(), fetch: healthy });
	expect(good.checks.every((c) => c.status === "ok")).toBe(true);
	expect(good.approver).toBe(true);
	expect(text(doctorView(good.checks))).toContain("Everything checked out.");

	const nothing = await doctor({ env: {}, creds: null, client: null, repo: repo({ isRepo: false, refspecs: { fetch: false, push: false }, templates: [] }), fetch: healthy });
	expect(status(nothing.checks)).toEqual({ server: "fail", "sign-in": "fail", repository: "skip" });
	expect(text(doctorView(nothing.checks))).toContain("ephyra login <server-url>");

	const rough = server({
		"/healthz": () => ({ ok: true, mode: "memory" }), "/v1/me": () => ({ principal: "ci", kind: "service", approver: false }),
		"/v1/setup": () => ({ status: "blocked", repository: { url: "x", branch: "main", head: "a".repeat(40) }, blockers: [{ id: "b", summary: "No isolated runner", action: "Grant one", owner: "operator" }] }),
		"/v1/inbox": () => Response.json({}, { status: 500 }),
	});
	const report = await doctor({ env: {}, creds: null, client: new Client(url, "t", rough, "ci"), url, repo: repo({ url: "git@git.example:team/app.git", refspecs: { fetch: true, push: false }, templates: [] }), fetch: rough });
	expect(status(report.checks)).toEqual({ server: "warn", "sign-in": "warn", repository: "ok", "remote URL": "warn", "journal refs": "warn", "policy files": "warn", setup: "fail", inbox: "skip" });
	const shown = text(doctorView(report.checks, 100));
	expect(shown).toContain("No isolated runner");
	expect(shown).toContain("1 thing to fix");
	// An unreachable server is a failure with a next step, not an exception.
	const down = await doctor({ env: {}, creds: null, client: null, url, repo: repo(), fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
	expect(down.checks[0]).toMatchObject({ name: "server", status: "fail" });
	expect((await doctor({ env: { EPHYRA_API_TOKEN: "t" }, creds: null, client: null, url, repo: repo(), fetch: healthy })).checks[1]!.detail).toContain("without EPHYRA_PRINCIPAL");
});

test("doctor reads a real repository: refspecs from ephyra init, templates, and a remote without its password", async () => {
	const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	expect(repoFacts(dir).isRepo).toBe(false);
	git("init", "-q", "-b", "trunk");
	git("remote", "add", "origin", "https://bot:hunter2-secret@git.example/team/app.git");
	const before = repoFacts(dir);
	expect(before).toMatchObject({ isRepo: true, remote: "origin", url: "https://git.example/team/app.git", refspecs: { fetch: false, push: false }, templates: [] });
	const { init } = await import("../src/index");
	await init(dir);
	await writeFile(join(dir, "note.txt"), "x");
	expect(repoFacts(dir)).toMatchObject({ refspecs: { fetch: true, push: true }, templates: ["autonomy.md", "thresholds.yaml", "models.yaml"] });
	expect(JSON.stringify(repoFacts(dir))).not.toContain("hunter2");
	fc.assert(fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{6,24}$/), (secret) => {
		for (const url of [`https://bot:${secret}@git.example/a/b.git`, `http://${secret}@h.example/x`, `ssh://git:${secret}@h.example/x`]) expect(withoutCredentials(url)).not.toContain(secret);
	}));
	expect(withoutCredentials("git@git.example:team/app.git")).toBe("git@git.example:team/app.git");
});

test("handoff prints a brief with the facts filled in and no credential, with or without a server", async () => {
	routes["GET /healthz"] = () => ({ ok: true, mode: "convex" });
	routes["GET /v1/me"] = () => ({ principal: "tester", kind: "service", approver: false });
	routes["GET /v1/setup"] = () => null;
	routes["GET /v1/inbox"] = () => [];
	const errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		await main(["handoff"]);
		const brief = printed();
		expect(brief).toContain("https://ephyra.quest/docs/agent.md");
		expect(brief).toContain("https://offline.example/auth.md");
		expect(brief).toContain("Ephyra server: https://offline.example");
		expect(brief).toContain("[warn] sign-in:");
		expect(brief).toContain("Report only checks and observations that actually happened");
		expect(brief).not.toContain("test-token-0123456789");
		expect(String(errors.mock.calls.at(-1)![0])).toContain("Paste the text above into your coding agent");
		await main(["handoff", "--json"]);
		expect(JSON.parse(String(out.mock.calls.at(-1)![0])).brief).toContain("What `ephyra doctor` reported:");
		await main(["doctor", "--json"]);
		expect(JSON.parse(String(out.mock.calls.at(-1)![0])).map((c: Check) => c.name)).toContain("server");
	} finally { errors.mockRestore(); }
	const offline = handoffBrief({ repo: repo({ isRepo: false, url: undefined, branch: undefined, refspecs: { fetch: false, push: false }, templates: [] }), report: { checks: [], setup: null, approver: null, principal: null }, env: { EPHYRA_DOCS_URL: "https://docs.internal.example" } });
	expect(offline).toContain("https://docs.internal.example/agent.md");
	expect(offline).not.toContain("/auth.md");
	expect(offline).toContain("not chosen yet");
});

// ───── The printed views ─────
test("views hold their width with hostile text and say unknown where a value is unknown", () => {
	const hostile = "‮evil\x1b[31m 全角 é " + "x".repeat(300);
	fc.assert(fc.property(fc.integer({ min: 40, max: 180 }), (w) => {
		const lines = [
			...runsView([{ id: hostile, trailId: null, short: hostile, step: hostile, persona: null, engine: hostile, executor: { kind: "local" }, status: "failed", startedAt: "2026-11-11T11:00:00Z" }], w, now),
			...runView({ id: "r", trailId: null, short: null, step: "patch", persona: null, engine: hostile, executor: { kind: "local", threadUrl: "https://t.example/x" }, status: "failed", startedAt: "2026-11-11T11:00:00Z", endedAt: "2026-11-11T11:05:00Z", error: hostile, usage: { tokens: null, costMicrousd: null } },
				[{ runId: "r", seq: 0, at: "2026-11-11T11:00:01Z", type: "tool_call", tool: { callId: "c", name: hostile, args: hostile } }, { runId: "r", seq: 1, at: "2026-11-11T11:00:02Z", type: "tool_result", tool: { callId: "c", name: "t", result: `${hostile}\n`.repeat(9), isError: true } }, { runId: "r", seq: 2, at: "2026-11-11T11:00:03Z", type: "reasoning", text: hostile }], w, now),
			...questionsView([{ id: "e".repeat(64), trailId: TRAIL, workspaceId: "w", bound: { rev: 1, head: "h" }, status: "awaiting_answer", question: hostile, reason: hostile, acceptance: "", recipient: null, createdAt: "2026-11-10T12:00:00Z", updatedAt: "2026-11-10T12:00:00Z", delivery: { kind: "inbox", status: "sent" }, checks: [] }], w, now),
			...agentsView([{ id: hostile, repository: { url: hostile, branch: hostile }, workspaceId: "w", scopes: ["bootstrap:read"], createdAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-10T00:00:00Z", revokedAt: null }], w, now),
			...setupView({ id: "s", mode: "supervised", status: "blocked", repository: { url: hostile, branch: "main", head: "a".repeat(40) }, startedAt: "2026-11-11T10:00:00Z", updatedAt: "2026-11-11T11:00:00Z", steps: [{ id: "1", name: hostile, status: "blocked", detail: hostile }], artifacts: [], blockers: [{ id: "b", summary: hostile, action: hostile, owner: "maintainer" }] }, w, now),
			...policyView(null, [{ path: hostile, kind: "autonomy", digest: "d".repeat(64), warnings: [hostile, `error: ${hostile}`] }], w, now),
			...doctorView([{ name: "server", status: "fail", detail: hostile, fix: hostile }], w),
		];
		for (const line of lines) {
			const joined = line.map((seg) => seg.text).join("");
			expect(joined).not.toMatch(/[\u0000-\u001f‪-‮]/);
		}
	}), { numRuns: 20 });
	const failed = text(runView({ id: "r", trailId: null, short: null, step: "patch", persona: null, engine: "codex/gpt", executor: { kind: "local" }, status: "done", startedAt: "2026-11-11T11:00:00Z", usage: { tokens: null, costMicrousd: null } }, [], 100, now));
	expect(failed).toContain("unknown tokens · unknown");
	expect(failed).not.toContain("$0.00");
	const usage = text(usageView({ from: "2026-11-04T00:00:00Z", to: "2026-11-11T00:00:00Z", totals: { entries: 0, costMicrousd: 0, unknownCost: 0, tokens: 0, wallMs: 0, failed: 0, unavailable: 0 }, byPersona: [], byEngine: [], byTrail: [{ trailId: TRAIL, short: "T-1a2b", title: "Cart total", totals: { entries: 1, costMicrousd: 0, unknownCost: 0, tokens: 1_900_000, wallMs: 0, failed: 0, unavailable: 0 }, budget: { spendMicrousdUsed: 0, spendMicrousdMax: 0, tokensUsed: 1_900_000, tokensMax: 2_000_000 } }], byDay: [] }, 110));
	expect(usage).toContain("1.9M/2.0M tokens");
	expect(usage).toContain("no metered allowance");
	expect(ago("2026-11-11T11:59:30Z", now)).toBe("just now");
	expect(ago("2026-11-11T09:00:00Z", now)).toBe("3h ago");
	expect(ago("2026-09-01T09:00:00Z", now)).toBe("2026-09-01");
});
