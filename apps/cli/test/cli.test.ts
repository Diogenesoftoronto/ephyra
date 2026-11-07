import { test, expect } from "bun:test";
import fc from "fast-check";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Client,
	inboxReducer,
	renderInbox,
	init,
	type InboxState,
} from "../src/index";
const item = {
	state: "ready" as const,
	bound: { rev: 1 },
	trailId: "id",
	short: "T-123",
	title: "Crash",
	area: "cart",
	risk: "low" as const,
	severity: 2,
	kind: "checkpoint" as const,
	checkpoint: "A" as const,
	blocking: true,
	artefact: { path: "hypothesis.md", summary: "Investigate" },
	createdAt: "2026-01-01T00:00:00Z",
};
const state: InboxState = { items: [item], selected: 0 };
for (const [key, action] of [
	["a", "approve"],
	["t", "claim"],
	["p", "park"],
	["o", "open"],
	["l", "land"],
	["e", "evidence"],
])
	test(`key ${key}`, () =>
		expect(inboxReducer(state, key!).command?.action).toBe(action));
for (const key of ["r", "c", "x"])
	test(`modal ${key}`, () =>
		expect(inboxReducer(state, key).state.modal).toBeDefined());
test("navigation and empty", () => {
	expect(inboxReducer(state, "j").state.selected).toBe(0);
	expect(inboxReducer(state, "k").state.selected).toBe(0);
	expect(inboxReducer({ items: [], selected: 0 }, "a").command).toBeUndefined();
});
test("random sequences retain bounds", () =>
	fc.assert(
		fc.property(fc.array(fc.string({ maxLength: 2 })), (keys) => {
			let s = state;
			for (const key of keys) {
				const result = inboxReducer(s, key);
				if (result.command) expect(s.items[s.selected]).toBeDefined();
				s = result.state;
				expect(s.selected).toBeGreaterThanOrEqual(0);
				expect(s.selected).toBeLessThan(s.items.length);
			}
		}),
	));
test("client uses bearer and typed paths", async () => {
	const calls: any[] = [];
	const client = new Client("http://example.test", "secret", (async (
		url,
		options,
	) => {
		calls.push([String(url), options]);
		return Response.json([]);
	}) as typeof fetch);
	await client.trails("ready");
	await client.action("a/b", "claim");
	expect(calls[0][0]).toEndWith("/v1/trails?state=ready");
	expect(calls[1][0]).toEndWith("/v1/trails/a%2Fb/claim");
	expect(calls[1][1].headers.Authorization).toBe("Bearer secret");
	expect(calls[1][1].headers["Idempotency-Key"]).toBeTruthy();
});
test("init preserves files and refspecs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ephyra-"));
	try {
		Bun.spawnSync(["git", "init", dir]);
		Bun.spawnSync(
			["git", "remote", "add", "origin", "https://example.invalid/repo"],
			{ cwd: dir },
		);
		await init(dir);
		await init(dir);
		expect(await readFile(join(dir, "ephyra/autonomy.md"), "utf8")).toContain(
			"mode: shadow",
		);
		const config = Bun.spawnSync(
			["git", "config", "--get-all", "remote.origin.push"],
			{ cwd: dir },
		)
			.stdout.toString()
			.trim()
			.split("\n");
		expect(config).toHaveLength(1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("80x24 rendering", () =>
	expect(renderInbox(state, 80, 24)).toMatchSnapshot());

test("principal and stale response", async () => {
	let headers: unknown;
	const fake = (async (_url, options) => {
		headers = options?.headers;
		return new Response(null, { status: 409 });
	}) as typeof fetch;
	const client = new Client("http://example.test", "secret", fake, "alice");
	await expect(client.action("id", "decide", {})).rejects.toThrow(
		"Stale decision",
	);
	expect((headers as Record<string, string>)["X-Ephyra-Principal"]).toBe(
		"alice",
	);
});
