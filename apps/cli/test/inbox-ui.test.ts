import { expect, test } from "bun:test";
import fc from "fast-check";
import { ProofBundle, Trail, TrailEvent, type InboxItem } from "@ephyra/core";
import { createTestRenderer } from "@opentui/core/testing";
import * as tui from "@opentui/core";
import {
	Client,
	DEMO_EVENTS,
	DEMO_FILES,
	DEMO_ITEMS,
	DEMO_OTHERS,
	DEMO_PROOF,
	DEMO_ROLLBACK,
	STAGES,
	detailKey,
	demoTrail,
	demoTrailFor,
	inboxReducer,
	inboxView,
	loadDetail,
	plain,
	renderInbox,
	toAnsi,
	toStyled,
	trailStory,
	trailView,
	trailsView,
	width,
	wrap,
	type InboxState,
	type StyledKit,
} from "../src/index";

// ───── The example data is real data ─────

test("demo trails, events and proof parse with the core schemas", () => {
	for (const m of [
		"triaged",
		"hypothesis",
		"plan",
		"proof",
		"watching",
		"set",
	] as const) {
		const { trail, events } = demoTrail(m);
		expect(() => Trail.parse(trail)).not.toThrow();
		for (const e of events) expect(() => TrailEvent.parse(e)).not.toThrow();
	}
	expect(() => ProofBundle.parse(DEMO_PROOF)).not.toThrow();
	expect(() => Trail.parse(DEMO_ROLLBACK.trail)).not.toThrow();
	for (const e of DEMO_ROLLBACK.events)
		expect(() => TrailEvent.parse(e)).not.toThrow();
	expect(new Set(DEMO_EVENTS.map((e) => e.id)).size).toBe(DEMO_EVENTS.length);
});

// ───── What a trail has been through ─────

test("the story follows the trail through its stages and gates", () => {
	const at = (m: Parameters<typeof demoTrail>[0]) => {
		const d = demoTrail(m);
		return trailStory(d.trail, d.events);
	};
	expect(at("triaged")).toMatchObject({ stage: 1 });
	expect(at("triaged").gate).toBeUndefined();
	expect(at("hypothesis")).toMatchObject({ stage: 2, gate: "A" });
	expect(at("plan")).toMatchObject({
		stage: 4,
		gate: "B",
		repro: { ok: true },
	});
	expect(at("plan").comments).toHaveLength(1);
	const proof = at("proof");
	expect(proof).toMatchObject({ stage: 6, gate: "C" });
	expect(proof.proof?.bundle.passed).toBe(true);
	expect(at("watching")).toMatchObject({ stage: 8 });
	expect(at("watching").gate).toBeUndefined();
	expect(at("watching").landings).toHaveLength(1);
	expect(at("set")).toMatchObject({ stage: STAGES.length, watchClean: true });
	const rb = trailStory(DEMO_ROLLBACK.trail, DEMO_ROLLBACK.events);
	expect(rb).toMatchObject({ stage: 1, reopened: true, rev: 2 });
	expect(rb.rollback?.newOid).toStartWith("e2a4c6e");
	expect(rb.proof).toBeUndefined(); // the rev 1 proof doesn't count for rev 2
});

test("story: a proof for an older revision is never shown as the current proof", () =>
	fc.assert(
		fc.property(
			fc.integer({ min: 1, max: 9 }),
			fc.integer({ min: 1, max: 9 }),
			(proofRev, trailRev) => {
				const d = demoTrail("proof");
				const events = d.events.map((e) =>
					e.type === "proof_completed"
						? ({
								...e,
								data: {
									...e.data,
									bundle: { ...e.data.bundle, rev: proofRev },
								},
							} as typeof e)
						: e,
				);
				const s = trailStory({ ...d.trail, rev: trailRev }, events);
				expect(s.proof !== undefined).toBe(proofRev === trailRev);
			},
		),
	));

test("story: any state and any prefix of events lands on a valid stage", () =>
	fc.assert(
		fc.property(
			fc.constantFrom(...Trail.shape.state.options),
			fc.integer({ min: 0, max: DEMO_EVENTS.length }),
			(state, k) => {
				const d = demoTrail("set");
				const s = trailStory({ ...d.trail, state }, d.events.slice(0, k));
				expect(s.stage).toBeGreaterThanOrEqual(0);
				expect(s.stage).toBeLessThanOrEqual(STAGES.length);
				if (s.gate)
					expect(["hypothesised", "planned", "ready"]).toContain(state);
			},
		),
	));

// ───── The screen ─────

const loaded = (
	item: InboxItem,
	m: Parameters<typeof demoTrail>[0],
	extra: Partial<InboxState> = {},
): InboxState => {
	const d = demoTrail(m);
	const path = item.artefact.path;
	return {
		items: [item, ...DEMO_OTHERS],
		selected: 0,
		details: {
			[detailKey(item)]: {
				status: "ready",
				...d,
				artefact: DEMO_FILES[path]
					? { status: "ready", text: DEMO_FILES[path]! }
					: { status: "missing" },
			},
		},
		...extra,
	};
};

test("checkpoint A shows the hypothesis, the triage and the rail", () => {
	const text = renderInbox(loaded(DEMO_ITEMS.A, "hypothesis"), 120, 40);
	expect(text).toContain("checkpoint A");
	expect(text).toContain("sumLineItems");
	expect(text).toContain("judgement-jev/jev-1.14");
	expect(text).toContain("waiting on you");
	expect(text).toContain("4 waiting");
});

test("checkpoint B shows the repro and the plan; C shows the proof", () => {
	const b = renderInbox(loaded(DEMO_ITEMS.B, "plan"), 120, 40);
	expect(b).toContain("checkout/one-cent-drift fails on base");
	expect(b).toContain("integer micro-cents");
	const c = renderInbox(loaded(DEMO_ITEMS.C, "proof"), 120, 40);
	expect(c).toContain("412 passed");
	expect(c).toContain("6 regression");
	expect(c).toContain("exported types unchanged");
});

test("e explains with the evidence index; ? lists the keys", () => {
	let s = loaded(DEMO_ITEMS.A, "hypothesis");
	s = inboxReducer(s, "e").state;
	const key = detailKey(DEMO_ITEMS.A);
	const entry = s.details![key]!;
	if (entry.status !== "ready") throw new Error("expected ready");
	s = {
		...s,
		details: {
			[key]: {
				...entry,
				evidence: { status: "ready", text: DEMO_FILES["evidence/index.json"]! },
			},
		},
	};
	expect(renderInbox(s, 120, 40)).toContain("8c1e0f2 show per-line discounts");
	s = inboxReducer(s, "?").state;
	expect(renderInbox(s, 120, 40)).toContain("take over: the agent stops");
	s = inboxReducer(s, "escape").state;
	expect(s.pane).toBe("detail");
});

test("every line is exactly the screen's width, at any size, with hostile text", () =>
	fc.assert(
		fc.property(
			fc.integer({ min: 40, max: 160 }),
			fc.integer({ min: 10, max: 60 }),
			fc.string({ maxLength: 120 }),
			fc.constantFrom("A", "B", "C") as fc.Arbitrary<"A" | "B" | "C">,
			fc.integer({ min: 0, max: 40 }),
			(w, h, junk, cp, scroll) => {
				const hostile = `${junk}\u202e\x1b[31m\u0007 第三 ✓ 🎉\n${junk}`;
				const item = { ...DEMO_ITEMS[cp], title: hostile, area: hostile };
				const m = cp === "A" ? "hypothesis" : cp === "B" ? "plan" : "proof";
				const s = loaded(item, m, { scroll });
				const key = detailKey(item);
				const e = s.details![key]!;
				if (e.status === "ready")
					s.details![key] = {
						...e,
						artefact: { status: "ready", text: hostile },
					};
				const lines = inboxView(s, w, h);
				expect(lines).toHaveLength(h);
				for (const line of lines) {
					const text = line.map((x) => x.text).join("");
					expect(width(text)).toBe(w);
					expect(text).not.toMatch(/[\x00-\x1f\x7f\u202a-\u202e]/);
				}
			},
		),
		{ numRuns: 150 },
	));

test("wrap never exceeds the width and keeps every word", () =>
	fc.assert(
		fc.property(
			fc.array(fc.stringMatching(/^[a-z第✓]{1,14}$/), { maxLength: 30 }),
			fc.integer({ min: 4, max: 60 }),
			(words, w) => {
				const lines = wrap(words.join(" "), w);
				for (const l of lines)
					expect(width(l)).toBeLessThanOrEqual(Math.max(w, 2));
				expect(lines.join("").replace(/ /g, "")).toBe(words.join(""));
			},
		),
	));

test("trail and trails views", () => {
	const d = demoTrail("watching");
	const text = plain(
		trailView(
			d.trail,
			d.events,
			{ hypothesis: { status: "ready", text: DEMO_FILES["hypothesis.md"]! } },
			100,
		),
	);
	expect(text).toContain("Radicle patch → refs/heads/main a71c3e5");
	expect(text).toContain("watch     2h · 1 fingerprint · 2 probes");
	const rb = plain(
		trailView(DEMO_ROLLBACK.trail, DEMO_ROLLBACK.events, {}, 100),
	);
	expect(rb).toContain("after a rollback");
	expect(rb).toContain("regressed");
	const set = demoTrail("set");
	expect(plain(trailView(set.trail, set.events, {}, 100))).toContain(
		"its repro now runs as a regression probe",
	);
	expect(plain(trailsView([d.trail, DEMO_ROLLBACK.trail], 100))).toContain(
		"T-738495",
	);
	expect(toAnsi(trailView(d.trail, d.events, {}, 80))).toContain("\x1b[");
});

// ───── The app, end to end, against a fake API ─────

function fakeApi(opts: { fail?: boolean } = {}) {
	const calls: string[] = [];
	const fetcher = (async (url: string | URL, init?: RequestInit) => {
		const u = new URL(String(url));
		calls.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
		if (opts.fail) return new Response(null, { status: 500 });
		if (u.pathname === "/v1/inbox")
			return Response.json([DEMO_ITEMS.A, ...DEMO_OTHERS]);
		if (u.pathname.endsWith("/file")) {
			const text = DEMO_FILES[u.searchParams.get("path") ?? ""];
			return text ? new Response(text) : new Response(null, { status: 404 });
		}
		if (u.pathname.startsWith("/v1/trails/")) {
			const id = decodeURIComponent(u.pathname.split("/")[3]!);
			return id === DEMO_ITEMS.A.trailId
				? Response.json(demoTrail("hypothesis"))
				: new Response(null, { status: 404 });
		}
		return Response.json({ ok: true });
	}) as typeof fetch;
	return {
		client: new Client("http://api.test", "secret", fetcher, "you"),
		calls,
	};
}

test("loadDetail fetches the trail, then the checkpoint's file, once per revision", async () => {
	const { client, calls } = fakeApi();
	let state: InboxState = { items: await client.inbox(), selected: 0 };
	await loadDetail(
		client,
		() => state,
		(s) => (state = s),
	);
	const entry = state.details![detailKey(DEMO_ITEMS.A)]!;
	expect(entry.status).toBe("ready");
	if (entry.status === "ready")
		expect(entry.artefact).toEqual({
			status: "ready",
			text: DEMO_FILES["hypothesis.md"]!,
		});
	const before = calls.length;
	await loadDetail(
		client,
		() => state,
		(s) => (state = s),
	);
	expect(calls.length).toBe(before); // cached
	state = inboxReducer(state, "e").state;
	await loadDetail(
		client,
		() => state,
		(s) => (state = s),
	);
	expect(calls.at(-1)).toBe(
		"GET /v1/trails/0193f2b6-7d4a-7c1e-9b2f-5e6a8c4c1e0f/file?path=evidence%2Findex.json",
	);
	expect(renderInbox(state, 120, 40)).toContain(
		"TotalMismatch in sumLineItems",
	);
});

test("a failing API shows an error in the pane, never a response body", async () => {
	const { client } = fakeApi();
	const broken = fakeApi({ fail: true }).client;
	let state: InboxState = { items: await client.inbox(), selected: 0 };
	await loadDetail(
		broken,
		() => state,
		(s) => (state = s),
	);
	expect(renderInbox(state, 100, 30)).toContain(
		"couldn't load the trail: API request failed (500)",
	);
});

test("the OpenTUI app draws styled frames and answers keys", async () => {
	const { client } = fakeApi();
	let state: InboxState = { items: await client.inbox(), selected: 0 };
	await loadDetail(
		client,
		() => state,
		(s) => (state = s),
	);
	const setup = await createTestRenderer({ width: 110, height: 34 });
	try {
		const kit = tui as unknown as StyledKit;
		const view = new tui.TextRenderable(setup.renderer, {
			content: toStyled(kit, inboxView(state, 110, 34)) as tui.StyledText,
			width: "100%",
			height: "100%",
		});
		setup.renderer.root.add(view);
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("T-4c1e0f");
		expect(frame).toContain("sumLineItems");
		expect(frame).toContain("●──●──◉");
		state = inboxReducer(state, "j").state;
		view.content = toStyled(kit, inboxView(state, 110, 34)) as tui.StyledText;
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("T-405162");
	} finally {
		setup.renderer.destroy();
	}
});

test("every Textbook story renders in OpenTUI's test renderer", async () => {
	const stories = (await import("../src/inbox.stories")) as Record<
		string,
		unknown
	>;
	const list = Object.entries(stories).filter(
		([k, v]) =>
			k !== "default" &&
			typeof (v as { render?: unknown })?.render === "function",
	) as [string, { name: string; render: (r: unknown) => unknown }][];
	expect(list.length).toBeGreaterThanOrEqual(15);
	for (const [key, s] of list) {
		const setup = await createTestRenderer({ width: 100, height: 30 });
		try {
			setup.renderer.root.add(
				(await s.render(setup.renderer)) as tui.Renderable,
			);
			await setup.renderOnce();
			const frame = setup.captureCharFrame();
			expect(frame.trim().length, key).toBeGreaterThan(0);
			if (
				key !== "Empty" &&
				!key.startsWith("Watching") &&
				!key.startsWith("RolledBack")
			)
				expect(frame, key).toContain("ephyra");
		} finally {
			setup.renderer.destroy();
		}
	}
});

test("the same trail at its next checkpoint is a fresh detail, not the cached one", async () => {
	// Regression: within one revision a trail moves A → B → C; caching by revision alone showed the old hypothesis.
	expect(detailKey(DEMO_ITEMS.A)).not.toBe(detailKey(DEMO_ITEMS.B));
	expect(detailKey(DEMO_ITEMS.B)).not.toBe(detailKey(DEMO_ITEMS.C));
	let served: "A" | "B" = "A";
	const calls: string[] = [];
	const fetcher = (async (url: string | URL) => {
		const u = new URL(String(url));
		calls.push(u.pathname + u.search);
		if (u.pathname === "/v1/inbox") return Response.json([DEMO_ITEMS[served]]);
		if (u.pathname.endsWith("/file"))
			return new Response(
				DEMO_FILES[u.searchParams.get("path") ?? ""] ?? null,
				{ status: DEMO_FILES[u.searchParams.get("path") ?? ""] ? 200 : 404 },
			);
		return Response.json(demoTrail(served === "A" ? "hypothesis" : "plan"));
	}) as typeof fetch;
	const client = new Client("http://api.test", "t", fetcher, "you");
	let state: InboxState = { items: await client.inbox(), selected: 0 };
	await loadDetail(
		client,
		() => state,
		(s) => (state = s),
	);
	expect(renderInbox(state, 120, 40)).toContain("hypothesis · waiting on you");
	served = "B";
	state = { ...state, items: await client.inbox() };
	await loadDetail(
		client,
		() => state,
		(s) => (state = s),
	);
	const text = renderInbox(state, 120, 40);
	expect(text).toContain("plan · waiting on you");
	expect(text).toContain("integer micro-cents");
	expect(calls).toContain(
		"/v1/trails/0193f2b6-7d4a-7c1e-9b2f-5e6a8c4c1e0f/file?path=plan.md",
	);
});

test("every other example item has a valid trail of its own", () => {
	for (const item of DEMO_OTHERS) {
		const { trail, events } = demoTrailFor(item);
		expect(() => Trail.parse(trail)).not.toThrow();
		for (const e of events) expect(() => TrailEvent.parse(e)).not.toThrow();
		expect(trail.id).toBe(item.trailId);
		expect(trail.state).toBe(item.state);
	}
});

test("the example autonomy policy parses with the real policy parser", async () => {
	const { parseAutonomy } = await import("@ephyra/policy");
	const { DEMO_TEXT } = await import("../src/index");
	const policy = parseAutonomy(DEMO_TEXT.autonomy);
	expect(policy.warnings).toEqual([]);
	const checkout = policy.areas.find((a) => a.name === "checkout")!;
	expect(checkout).toMatchObject({
		risk: "medium",
		landing: ["radicle_patch"],
		watch: "2h",
		overrides: { A: "blocking", B: "blocking", C: "blocking" },
	});
	expect(policy.areas.find((a) => a.name === "docs")).toMatchObject({
		risk: "low",
		landing: ["auto_land"],
		watch: "1h",
	});
});

test("the walkthrough export renders every step at its exact size", async () => {
	const out = `${process.env.TMPDIR ?? "/tmp"}/ephyra-walkthrough-${process.pid}.json`;
	const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../scripts/walkthrough.ts`, out, "96", "30"], { stdout: "pipe", stderr: "pipe" });
	expect(await proc.exited).toBe(0);
	const data = (await Bun.file(out).json()) as { steps: { id: string; wide: [string, string][][]; narrow: [string, string][][] }[] };
	expect(data.steps.map((s) => s.id)).toEqual(["triaged", "hypothesis", "explain", "revise", "plan", "proof", "watching", "set", "rollback"]);
	for (const s of data.steps) {
		expect(s.wide).toHaveLength(30);
		for (const row of s.wide) expect(width(row.map((x) => x[0]).join(""))).toBe(96);
		for (const row of s.narrow) expect(width(row.map((x) => x[0]).join(""))).toBe(46);
	}
	// The landing page ships a copy. It must be this one, and its steps must be the page's steps, in order.
	const site = `${import.meta.dir}/../../../site/e`;
	expect(await Bun.file(`${site}/walkthrough.json`).text(), "regenerate: bun run apps/cli/scripts/walkthrough.ts site/e/walkthrough.json").toBe(
		await Bun.file(out).text(),
	);
	const page = await Bun.file(`${site}/index.html`).text();
	expect([...page.matchAll(/data-step="([a-z]+)"/g)].map((m) => m[1])).toEqual(data.steps.map((s) => s.id));
	await Bun.file(out).delete();
});
