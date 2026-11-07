import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextRenderable } from "@opentui/core";
import {
	Client,
	inboxReducer,
	renderInbox,
	runCommand,
	type InboxState,
} from "../src/index";

const item = {
	trailId: "id",
	short: "T-123",
	title: "Crash",
	area: "cart",
	risk: "low" as const,
	severity: 2,
	state: "ready" as const,
	bound: { rev: 1 },
	kind: "checkpoint" as const,
	checkpoint: "A" as const,
	blocking: true,
	artefact: { path: "a", summary: "Investigate" },
	createdAt: "2026-01-01T00:00:00Z",
	landingUrl: "https://example.test",
	evidenceIndex: "evidence/index.json",
};
const initial: InboxState = { items: [item], selected: 0 };

for (const [key, action] of [
	["r", "revise"],
	["c", "comment"],
	["x", "kill"],
] as const) {
	test(`${key} modal accepts a note`, () => {
		let state = inboxReducer(initial, key).state;
		state = inboxReducer(state, "h").state;
		state = inboxReducer(state, "i").state;
		expect(inboxReducer(state, "return").command).toEqual({
			action,
			item,
			note: "hi",
		});
		expect(inboxReducer(state, "escape").state.modal).toBeUndefined();
	});
}
test("parked resumes and only ready trails can land", () => {
	const parked = { ...item, state: "parked" as const };
	expect(
		inboxReducer({ items: [parked], selected: 0 }, "p").command?.action,
	).toBe("resume");
	expect(
		inboxReducer({ items: [parked], selected: 0 }, "l").command,
	).toBeUndefined();
});
for (const status of [409, 500]) {
	test(`optimistic decision rolls back on ${status}`, async () => {
		let pending: InboxState | undefined;
		const client = new Client(
			"https://example.test",
			"secret",
			(async () => new Response(null, { status })) as unknown as typeof fetch,
			"alice",
		);
		const result = await runCommand(
			client,
			initial,
			{ action: "approve", item },
			(state) => {
				pending = state;
			},
		);
		expect(pending?.items).toEqual([]);
		expect(result.items).toEqual([item]);
		expect(result.error).toContain(
			status === 409 ? "Stale" : "outcome unknown",
		);
	});
}
test("OpenTUI renders the inbox in its native test renderer", async () => {
	const setup = await createTestRenderer({ width: 80, height: 24 });
	try {
		setup.renderer.root.add(
			new TextRenderable(setup.renderer, {
				content: renderInbox(initial),
				width: "100%",
			}),
		);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("T-123");
	} finally {
		setup.renderer.destroy();
	}
});

test("navigation moves between items and empty inbox emits no commands", () => {
	const second = { ...item, trailId: "other" };
	let state: InboxState = { items: [item, second], selected: 0 };
	state = inboxReducer(state, "j").state;
	expect(state.selected).toBe(1);
	state = inboxReducer(state, "k").state;
	expect(state.selected).toBe(0);
	for (const key of "jakrxctp ole".replaceAll(" ", "")) {
		expect(
			inboxReducer({ items: [], selected: 0 }, key).command,
		).toBeUndefined();
	}
});

test("short IDs resolve exactly and reject collisions", async () => {
	const ids = [
		"00000000-0000-7000-8000-000000abcdef",
		"00000000-0000-7000-8000-000000123456",
	];
	const calls: string[] = [];
	const fetcher = (async (url: string | URL | Request) => {
		calls.push(String(url));
		return Response.json(
			calls.length === 1
				? ids.map((id) => ({ id }))
				: { trail: { id: ids[0] }, events: [] },
		);
	}) as typeof fetch;
	const client = new Client("https://example.test", "token", fetcher, "alice");
	await client.show("T-abcdef");
	expect(calls[1]).toEndWith(ids[0]!);
});
