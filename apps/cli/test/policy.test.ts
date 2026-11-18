import { afterEach, beforeEach, expect, mock, spyOn, test, type Mock } from "bun:test";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySketches, parseAutonomy, renderAutonomy, sketchesOf } from "@ephyra/policy";
import type { AreaSketch } from "@ephyra/core";
import { Client, type PolicyDraft } from "../src/client";
import { main } from "../src/commands/cli";
import { plain } from "../src/inbox/view";
import { boardReducer, boardSketches, boardView, initialBoard, mapView, summary, unsaved, type BoardState } from "../src/policy/board";
import { lineDiff, performBoard, policyCommand } from "../src/policy/commands";

const DOC = [
	"# Autonomy policy", "",
	"## defaults", "mode: enforce", "checkpoints: A=advisory B=advisory C=advisory", "landing: trail_ref", "watch: 2h", "decide: judgement", "",
	"## area: site", "paths: site/**, apps/web/**", "risk: low", "user_facing: true", "landing: auto_land", "watch: 1h", "The public site.", "",
	"## area: server", "paths: apps/server/**", "risk: high", "user_facing: true", "landing: pull_request", "A named human approves C.", "",
	"## area: core", "paths: packages/core/**", "risk: critical", "user_facing: false", "checkpoints: A=blocking B=blocking C=blocking", "The shared contracts.", "",
].join("\n");
const SKETCHES = sketchesOf(parseAutonomy(DOC));
const press = (state: BoardState, ...keys: string[]) => keys.reduce((s, key) => boardReducer(s, key).state, state);
const fresh = () => initialBoard({ published: DOC });

test("the map is one line per area: risk, a five-pip level and paths, with a one-line summary", () => {
	expect(SKETCHES.map((s) => [s.name, s.level])).toEqual([["site", "auto"], ["server", "patch"], ["core", "research"]]);
	expect(summary(SKETCHES)).toBe("3 areas · 1 lands by itself · 1 critical");
	const text = plain(mapView(SKETCHES, 80));
	expect(text.split("\n")).toHaveLength(4);
	expect(text).toContain("site    low       ●●●●● Auto-land  site/**, apps/web/**");
	expect(text).toContain("core    critical  ●●○○○ Research");
	for (const w of [40, 60, 120]) for (const line of plain(mapView(SKETCHES, w)).split("\n")) expect(Array.from(line)).toHaveLength(w);
});

test("moving one area on the board changes only that area in the document, and going back leaves nothing unsaved", () => {
	let state = press(fresh(), "j", "left");
	expect(boardSketches(state)[1]).toMatchObject({ name: "server", level: "propose" });
	expect(unsaved(state)).toBe(true);
	const policy = parseAutonomy(state.text);
	// Site keeps the landing and watch it was written with; server is rewritten from the level table.
	expect(policy.areas[0]).toMatchObject({ landing: ["auto_land"], watch: "1h" });
	expect(policy.areas[1]).toMatchObject({ overrides: { A: "advisory", B: "blocking", C: "blocking" }, landing: ["trail_ref"] });
	expect(policy.warnings).toEqual([]);
	expect(plain(boardView(state, 100, 30))).toContain("1 change from the policy in effect");
	state = press(state, "z");
	expect(unsaved(state)).toBe(false);
	expect(state.text).toBe(DOC);
});

test("a critical area cannot be raised to Auto-land, and raising risk to critical brings an auto-landing area down", () => {
	const top = press(fresh(), "G", "5");
	expect(top.error).toContain("never lands by itself");
	expect(unsaved(top)).toBe(false);
	const raised = press(fresh(), "r", "r", "r");
	expect(boardSketches(raised)[0]).toMatchObject({ risk: "critical", level: "patch" });
	expect(raised.notice).toContain("now at Patch");
});

test("paths, description, new and removed areas go through the same parser the server uses", () => {
	let state = press(fresh(), "p", ...Array(30).fill("backspace"), ..."docs/**, README.md", "return");
	expect(boardSketches(state)[0]!.paths).toEqual(["docs/**", "README.md"]);
	state = press(state, "n", ..."Bad Name", "return");
	expect(state.error).toContain("lowercase");
	state = press(state, "escape", "n", ..."docs", "return", "i", ..."risk: low", "return");
	const added = boardSketches(state).at(-1)!;
	expect(added).toMatchObject({ name: "docs", level: "research", risk: "medium" });
	// A description that looks like a setting stays a description.
	expect(parseAutonomy(state.text).areas.at(-1)).toMatchObject({ risk: "medium", prose: "Risk: low\n" });
	state = press(state, "D");
	expect(boardSketches(state).map((s) => s.name)).toEqual(["site", "server", "core"]);
	const removed = press(fresh(), "D");
	expect(plain(boardView(removed, 100, 30))).toContain("site  removed");
	expect(press(removed, "Z").text).toBe(DOC);
});

test("quitting with unsaved edits asks first, and publishing needs a saved open draft", () => {
	const dirty = press(fresh(), "left");
	expect(boardReducer(dirty, "q").state.modal).toEqual({ kind: "quit" });
	expect(boardReducer(press(dirty, "q"), "y").command).toEqual({ action: "quit" });
	expect(boardReducer(fresh(), "q").command).toEqual({ action: "quit" });
	expect(press(dirty, "P").error).toContain("Save first");
	expect(press(fresh(), "P").notice).toContain("no open draft");
	const drafted = initialBoard({ published: DOC, draft: { id: "draft-1234", content: DOC } });
	expect(boardReducer(press(drafted, "P"), "y").command).toEqual({ action: "publish" });
	expect(boardReducer(press(drafted, "P"), "n").command).toBeUndefined();
});

test("any run of board keys leaves a document that parses without warnings and a frame of exactly the screen size", () => {
	const key = fc.constantFrom("j", "k", "left", "right", "1", "3", "5", "r", "u", "D", "z", "Z", "g", "G", "?", "escape", "n", "a", "b", "return", "p", "i", "backspace");
	fc.assert(fc.property(fc.array(key, { maxLength: 40 }), fc.integer({ min: 40, max: 140 }), fc.integer({ min: 12, max: 50 }), (keys, w, h) => {
		const state = press(fresh(), ...keys);
		expect(parseAutonomy(state.text).warnings).toEqual([]);
		const frame = boardView(state, w, h);
		expect(frame).toHaveLength(h);
		for (const line of plain(frame).split("\n")) expect(Array.from(line)).toHaveLength(w);
		// The board and the server agree: applying the board's map to the published document gives the board's map back.
		if (!state.modal) expect(sketchesOf(parseAutonomy(renderAutonomy(applySketches(parseAutonomy(DOC), boardSketches(state)).policy)))).toEqual(boardSketches(state));
	}));
});

test("lineDiff marks exactly the lines that differ", () => {
	expect(lineDiff("a\nb\nc", "a\nx\nc\nd").map((l) => l.sign + l.text)).toEqual([" a", "-b", "+x", " c", "+d"]);
});

// ───────────── the commands, against a fake server ─────────────

type Seen = { method: string; path: string; body: unknown; headers: Headers };
let requests: Seen[];
let routes: Record<string, (body: any) => unknown>;
let out: Mock<typeof console.log>;
let saved: Record<string, string | undefined>;
let fetchDescriptor: PropertyDescriptor | undefined;
let dir: string;
const ENV = ["EPHYRA_CREDENTIALS", "EPHYRA_URL", "EPHYRA_API_TOKEN", "EPHYRA_PRINCIPAL", "NO_COLOR", "EDITOR", "VISUAL"];
const printed = () => out.mock.calls.map((call) => String(call[0])).join("\n");
const digest = "d".repeat(64);
const doc = () => ({ path: "autonomy.md", kind: "autonomy", content: DOC, digest, warnings: [], sketches: SKETCHES });
const draftOf = (content: string, extra: Partial<PolicyDraft> = {}): PolicyDraft => ({
	id: "draft-1234-abcd", path: "autonomy.md", baseDigest: digest, content, warnings: [], status: "open", updatedAt: "2026-11-17T12:00:00Z",
	sketches: sketchesOf(parseAutonomy(content)), ...extra,
});
/** The fake server renders the map the way the real one does. */
const serve = (state: { draft?: PolicyDraft }) => {
	routes["GET /v1/docs"] = () => [doc()];
	routes["GET /v1/docs/autonomy.md"] = () => doc();
	routes["GET /v1/policy/active"] = () => null;
	routes["GET /v1/drafts"] = () => (state.draft ? [state.draft] : []);
	routes["POST /v1/drafts"] = () => (state.draft = draftOf(DOC));
	routes["PUT /v1/drafts/draft-1234-abcd/sketches"] = (body: { sketches: AreaSketch[] }) =>
		(state.draft = draftOf(renderAutonomy(applySketches(parseAutonomy(state.draft!.content), body.sketches).policy)));
	routes["PUT /v1/drafts/draft-1234-abcd/content"] = (body: { content: string }) => (state.draft = draftOf(body.content, { warnings: parseAutonomy(body.content).warnings }));
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ephyra-policy-test-"));
	saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
	Object.assign(process.env, { EPHYRA_CREDENTIALS: join(dir, "credentials.json"), EPHYRA_URL: "https://offline.example", EPHYRA_API_TOKEN: "test-token-0123456789", EPHYRA_PRINCIPAL: "tester" });
	requests = [];
	routes = {};
	fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	const transport = mock((async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		requests.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body, headers: new Headers(init?.headers) });
		const handler = routes[`${init?.method ?? "GET"} ${url.pathname}`];
		if (!handler) return Response.json({ error: "not found" }, { status: 404 });
		const value = handler(body);
		return value instanceof Response ? value : Response.json(value);
	}) as typeof fetch);
	Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: transport });
	out = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
	if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
	out.mockRestore();
	for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	await rm(dir, { recursive: true, force: true });
});

test("`ephyra policy` prints the map with the receipt, and --json carries the areas", async () => {
	serve({});
	await main(["policy"]);
	expect(printed()).toContain("3 areas · 1 lands by itself · 1 critical");
	expect(printed()).toContain("●●●●○ Patch");
	expect(printed()).toContain("none activated");
	expect(requests.every((r) => r.method === "GET")).toBe(true);
	await main(["policy", "--json"]);
	const value = JSON.parse(String(out.mock.calls.at(-1)![0]));
	expect(value.areas.map((a: AreaSketch) => a.name)).toEqual(["site", "server", "core"]);
	expect(value.documents[0]).toEqual({ path: "autonomy.md", kind: "autonomy", digest, warnings: [] });
	expect(value.draft).toBeNull();
});

test("`policy set` saves one area's change to a draft and says nothing is in effect", async () => {
	const state: { draft?: PolicyDraft } = {};
	serve(state);
	await main(["policy", "set", "server", "--level", "propose", "--risk", "medium"]);
	const put = requests.find((r) => r.method === "PUT")!;
	expect(put.path).toBe("/v1/drafts/draft-1234-abcd/sketches");
	expect((put.body as { sketches: AreaSketch[]; baseDigest: string }).baseDigest).toBe(digest);
	expect((put.body as { sketches: AreaSketch[] }).sketches.map((s) => [s.name, s.level, s.risk])).toEqual([["site", "auto", "low"], ["server", "propose", "medium"], ["core", "research", "critical"]]);
	expect(put.headers.get("idempotency-key")).toBeTruthy();
	expect(printed()).toContain("~ server");
	expect(printed()).toContain("Saved to draft draft-12. Nothing is in effect yet.");
	// A second change continues the same draft rather than starting over.
	await main(["policy", "add", "docs", "--paths", "docs/**, README.md", "--level", "auto", "--risk", "low", "--about", "Words about the code."]);
	expect(requests.filter((r) => r.method === "POST" && r.path === "/v1/drafts")).toHaveLength(1);
	expect(state.draft!.sketches!.map((s) => s.name)).toEqual(["site", "server", "core", "docs"]);
	expect(state.draft!.sketches![1]!.level).toBe("propose");
	await main(["policy", "rm", "docs"]);
	expect(state.draft!.sketches!.map((s) => s.name)).toEqual(["site", "server", "core"]);
	await main(["policy", "diff"]);
	expect(printed()).toContain("+ checkpoints: A=advisory B=blocking C=blocking");
});

test("`policy set` refuses what it cannot mean, before any write", async () => {
	serve({});
	for (const bad of [["policy", "set", "server"], ["policy", "set", "server", "--level", "yolo"], ["policy", "set", "server", "--risk", "spicy"], ["policy", "set"], ["policy", "frobnicate"], ["policy", "set", "server", "--user-facing", "--internal"]])
		await expect(main(bad), bad.join(" ")).rejects.toThrow(/Usage: ephyra policy/);
	await expect(main(["policy", "set", "nope", "--level", "patch"])).rejects.toThrow("No area named nope. Areas: site, server, core.");
	await expect(main(["policy", "set", "core", "--level", "auto"])).rejects.toThrow("never lands by itself");
	await expect(main(["policy", "add", "site", "--level", "patch"])).rejects.toThrow("already exists");
	await expect(main(["policy", "edit"])).rejects.toThrow("needs a terminal");
	expect(requests.every((r) => r.method === "GET")).toBe(true);
});

test("publish, activate and discard are separate steps, and a refusal is said as one", async () => {
	const state: { draft?: PolicyDraft } = { draft: draftOf(DOC) };
	serve(state);
	routes["POST /v1/drafts/draft-1234-abcd/publish"] = () => Response.json({ error: "only an approver can publish a draft" }, { status: 403 });
	await expect(main(["policy", "publish"])).rejects.toThrow("Only a signed-in approver can do that");
	const published = { ref: "refs/ephyra/policy/draft-1234-abcd", commit: "a".repeat(40), by: "tester", at: "2026-11-17T12:05:00Z" };
	routes["POST /v1/drafts/draft-1234-abcd/publish"] = () => (state.draft = draftOf(DOC, { status: "published", published }));
	await main(["policy", "publish"]);
	expect(printed()).toContain("Published aaaaaaaaaaaa. It is not in effect until it is activated.");
	routes["GET /v1/drafts"] = () => [state.draft];
	routes["POST /v1/drafts/draft-1234-abcd/activate"] = () => ({ commit: "b".repeat(40) });
	await main(["policy", "activate"]);
	const sent = requests.at(-1)!.body as { expectedCommit: string; expectedDigest: string; expectedActive: null };
	expect(sent.expectedCommit).toBe(published.commit);
	expect(sent.expectedDigest).toBe(new Bun.CryptoHasher("sha256").update(DOC).digest("hex"));
	expect(sent.expectedActive).toBeNull();
	expect(printed()).toContain("In effect: bbbbbbbbbbbb.");
	routes["GET /v1/drafts"] = () => [];
	await expect(main(["policy", "discard"])).rejects.toThrow("There is no open draft");
});

test("the raw document is one command away, to read or to edit", async () => {
	const state: { draft?: PolicyDraft } = {};
	serve(state);
	const write = spyOn(process.stdout, "write").mockImplementation(() => true);
	try {
		await main(["policy", "raw"]);
		expect(String(write.mock.calls.at(-1)![0])).toBe(DOC);
	} finally {
		write.mockRestore();
	}
	const c = new Client("https://offline.example", "test-token-0123456789", fetch, "tester");
	const edited = DOC.replace("risk: high", "risk: medium");
	const lines: string[] = [];
	await policyCommand(c, ["edit", "--raw"], {
		json: false, cols: 100, interactive: true, paint: (l) => lines.push(plain(l)), emit: () => {}, usage: () => new Error("usage"), receipt: () => [],
		editor: async (text, name) => { expect(text).toBe(DOC); expect(name).toBe("autonomy.md"); return edited; },
	});
	expect(requests.at(-1)!.path).toBe("/v1/drafts/draft-1234-abcd/content");
	expect(requests.at(-1)!.body).toEqual({ content: edited, baseDigest: digest });
	expect(lines.join("\n")).toContain("Saved to draft draft-12.");
});

test("the board saves the map, or the text after a raw edit, and never claims an unconfirmed write", async () => {
	const state: { draft?: PolicyDraft } = {};
	serve(state);
	const c = new Client("https://offline.example", "test-token-0123456789", fetch, "tester");
	const edit = async (text: string) => text.replace("The public site.", "The public site and blog.");
	let board = press(fresh(), "j", "left");
	let done = await performBoard(c, board, { action: "save" }, { edit });
	expect(requests.at(-1)!.path).toEndWith("/sketches");
	expect(unsaved(done.state)).toBe(false);
	expect(done.state.notice).toContain("Saved to draft draft-12");
	expect(done.state.draft).toEqual({ id: "draft-1234-abcd", status: "open" });
	// e: the raw document comes back edited; the next save sends text.
	done = await performBoard(c, done.state, { action: "raw" }, { draft: done.draft!, edit });
	expect(done.state.raw).toBe(true);
	expect(boardSketches(done.state)[0]!.intent).toBe("The public site and blog.");
	done = await performBoard(c, done.state, { action: "save" }, { draft: done.draft!, edit });
	expect(requests.at(-1)!.path).toEndWith("/content");
	expect(done.state.raw).toBe(false);
	// A save the server never answered is reported as unknown, and the edits stay.
	routes["PUT /v1/drafts/draft-1234-abcd/sketches"] = () => { throw new Error("socket hang up"); };
	board = press(done.state, "left");
	const lost = await performBoard(c, board, { action: "save" }, { draft: done.draft!, edit });
	expect(lost.state.error).toContain("outcome is unknown");
	expect(unsaved(lost.state)).toBe(true);
	routes["PUT /v1/drafts/draft-1234-abcd/sketches"] = () => Response.json({ error: "stale" }, { status: 409 });
	expect((await performBoard(c, board, { action: "save" }, { draft: done.draft!, edit })).state.error).toContain("The server refused");
});
