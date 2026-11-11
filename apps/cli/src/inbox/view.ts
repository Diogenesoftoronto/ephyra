// The inbox, laid out as styled lines. Pure: the OpenTUI app, the ANSI fallback, the Textbook stories, the
// snapshot tests and the landing page's walkthrough all render this one function's output.
// Colour is state: mint is a signal (a bug, something waiting on you), amber is work that holds, cherry is an
// undo or a failure. Everything agent- or human-written goes through text.ts before it reaches a line.
import type {
	InboxItem,
	ProofBundle,
	ProofItem,
	Trail,
	TrailEvent,
} from "@ephyra/core";
import { docsBase } from "../docs";
import {
	availableKeys,
	detailKey,
	docsFor,
	type DetailEntry,
	type FileEntry,
	type InboxState,
} from "./reducer";
import {
	GATE_AT,
	MODE,
	STAGES,
	duration,
	trailStory,
	usd,
	type Activity,
	type TrailStory,
} from "./story";
import { oneLine, tail, trunc, width, wrap } from "./text";

export type Tone =
	| "fg"
	| "strong"
	| "muted"
	| "dim"
	| "border"
	| "amber"
	| "mint"
	| "cherry"
	| "key";
export type Seg = { text: string; tone?: Tone; bold?: boolean };
export type Line = Seg[];

const g = (text: string, tone: Tone = "fg", bold = false): Seg =>
	bold ? { text, tone, bold } : { text, tone };
export const plain = (lines: Line[]) =>
	lines.map((l) => l.map((x) => x.text).join("")).join("\n");
const lineWidth = (line: Line) => line.reduce((n, x) => n + width(x.text), 0);

/** A line cut or padded to exactly `w` columns. */
export function row(line: Line, w: number): Line {
	const out: Line = [];
	let used = 0;
	for (const seg of line) {
		if (used >= w) break;
		const text =
			width(seg.text) > w - used ? trunc(seg.text, w - used) : seg.text;
		if (text) out.push({ ...seg, text });
		used += width(text);
	}
	if (used < w) out.push({ text: " ".repeat(w - used) });
	return out;
}

/** Left and right parts on one line, the right one flush with the edge (dropped if there's no room). */
function spread(left: Line, right: Line, w: number): Line {
	const gap = w - lineWidth(left) - lineWidth(right);
	return gap >= 1 ? [...left, g(" ".repeat(gap)), ...right] : row(left, w);
}

/** Wrapped text as lines of one tone. */
const para = (text: string, w: number, tone: Tone = "fg") =>
	wrap(text, w).map((t) => [g(t, tone)]);

/** A label column and a value, the value wrapped under itself. */
function fact(
	label: string,
	value: Line | string,
	w: number,
	labelTone: Tone = "muted",
): Line[] {
	const lw = Math.max(10, label.length + 1);
	const v = typeof value === "string" ? [g(value)] : value;
	const text = v.map((x) => x.text).join("");
	if (lineWidth(v) <= w - lw || v.length > 1)
		return [[g(label.padEnd(lw), labelTone), ...v]];
	const lines = wrap(text, w - lw);
	return lines.map((t, i) => [
		g(i ? " ".repeat(lw) : label.padEnd(lw), labelTone),
		g(t, v[0]?.tone ?? "fg"),
	]);
}

// ───── Boxes ─────

function box(
	title: Line,
	body: Line[],
	w: number,
	h: number,
	scroll: number,
	focus: boolean,
): Line[] {
	const inner = w - 2;
	const rows = Math.max(0, h - 2);
	const max = Math.max(0, body.length - rows);
	const off = Math.min(Math.max(0, scroll), max);
	const edge: Tone = focus ? "border" : "dim";
	const t = row(title, Math.min(lineWidth(title), Math.max(0, inner - 4)));
	const top: Line = [
		g("┌─", edge),
		g(" "),
		...t,
		g(" "),
		g("─".repeat(Math.max(0, inner - 3 - lineWidth(t))), edge),
		g("┐", edge),
	];
	const out: Line[] = [row(top, w)];
	for (let i = 0; i < rows; i++)
		out.push([g("│", edge), ...row(body[off + i] ?? [], inner), g("│", edge)]);
	const more = off < max ? " ↓ J " : off > 0 ? " ↑ K " : "";
	out.push([
		g("└", edge),
		g("─".repeat(Math.max(0, inner - more.length - 1)), edge),
		g(more, "muted"),
		g(more ? "─" : "─", edge),
		g("┘", edge),
	]);
	return out.map((l) => row(l, w));
}

// ───── The list ─────

function glyph(item: InboxItem): Seg {
	if (item.kind === "checkpoint")
		return g(
			item.checkpoint ?? "?",
			item.blocking ? "mint" : "muted",
			item.blocking,
		);
	if (item.kind === "spend") return g("$", "mint", true);
	if (item.kind === "parked") return g("‖", "mint", true);
	return g("!", "mint", true);
}

function listLines(state: InboxState, w: number, rows: number): Line[] {
	if (!state.items.length) return [[g(" Nothing waiting.", "muted")]];
	const roomy = state.items.length * 3 <= rows;
	const out: Line[] = [];
	state.items.forEach((item, i) => {
		const sel = i === state.selected;
		const sev: Line = [
			g(`sev ${item.severity}`, item.severity >= 3 ? "mint" : "muted"),
			g(" "),
		];
		const fixed = 1 + width(item.short) + 2 + 1 + 2;
		const room = w - fixed - lineWidth(sev) - 1;
		const head: Line = [
			g(sel ? "▌" : " ", "strong"),
			g(item.short, sel ? "strong" : "fg", sel),
			g("  "),
			glyph(item),
			g("  "),
			g(trunc(oneLine(item.area), Math.max(0, room)), "muted"),
		];
		out.push(room >= 3 ? spread(head, sev, w) : row(head, w));
		out.push([
			g(sel ? "▌" : " ", "strong"),
			g(oneLine(item.title), sel ? "fg" : "muted"),
		]);
		if (roomy && i < state.items.length - 1) out.push([]);
	});
	return out;
}

// ───── The trail's stages ─────

/** ●──●──◉──○… with the checkpoint letters under their stages. Two lines, 3 columns per stage. */
export function rail(
	story: Pick<
		TrailStory,
		"stage" | "gate" | "halted" | "decisions" | "reopened" | "rev"
	>,
): [Line, Line, Seg] {
	const top: Line = [];
	const done = story.stage >= STAGES.length;
	STAGES.forEach((_, i) => {
		let seg: Seg;
		if (done || i < story.stage) seg = g("●", "amber");
		else if (i === story.stage) {
			if (story.halted === "rolled_back") seg = g("✕", "cherry", true);
			else if (story.halted) seg = g("‖", "mint", true);
			else seg = g("◉", story.gate ? "mint" : "amber", true);
		} else seg = g("○", "dim");
		top.push(seg);
		if (i < STAGES.length - 1)
			top.push(g("──", done || i < story.stage ? "amber" : "dim"));
	});
	const label = done
		? g("  set", "amber", true)
		: story.reopened && !story.halted && !story.gate
			? g(
					`  rev ${story.rev} · ${STAGES[story.stage]} again, after a rollback`,
					"cherry",
				)
			: story.halted === "rolled_back"
				? g("  rolled back", "cherry", true)
				: story.halted
					? g(
							`  ${story.halted.replace("_", " ")} at ${STAGES[story.stage]}`,
							"mint",
						)
					: story.gate
						? g(`  ${STAGES[story.stage]} · waiting on you`, "mint")
						: g(`  ${STAGES[story.stage]}`, "amber");
	const gates: Line = [];
	let col = 0;
	for (const k of ["A", "B", "C"] as const) {
		const at = GATE_AT[k] * 3;
		gates.push(g(" ".repeat(at - col)));
		const decided = story.decisions[k];
		const tone: Tone =
			story.gate === k
				? "mint"
				: decided?.verdict === "approve"
					? "amber"
					: decided
						? "cherry"
						: "dim";
		gates.push(g(k, tone, story.gate === k));
		col = at + 1;
	}
	return [top, gates, label];
}
/** The rail as lines for a given width: the label beside it when there's room, else under it. */
function railLines(r: [Line, Line, Seg], w: number): Line[] {
	const [top, gates, label] = r;
	if (lineWidth(top) + width(label.text) <= w) return [[...top, label], gates];
	return [top, gates, [{ ...label, text: label.text.trimStart() }]];
}

const STATE_AT: Partial<Record<Trail["state"], number>> = {
	sensed: 0,
	triaged: 1,
	researching: 1,
	hypothesised: 2,
	reproducing: 3,
	planned: 4,
	patching: 5,
	proving: 6,
	ready: 6,
	landing: 7,
	watching: 8,
	rolled_back: 8,
	closed: STAGES.length,
};
/** A rail from the inbox item alone, while the trail's events are loading. */
function itemRail(item: InboxItem): [Line, Line, Seg] {
	const gate = item.kind === "checkpoint" ? item.checkpoint : undefined;
	return rail({
		stage: gate ? GATE_AT[gate] : (STATE_AT[item.state] ?? 0),
		gate,
		decisions: {},
		rev: item.bound.rev,
	});
}

// ───── Markdown, lightly ─────

/** Headings, bullets and code fences from agent-written Markdown. Text only: nothing in it can style the screen. */
const blank = (l: Line | undefined) => !l || l.every((x) => !x.text.trim());
function markdown(text: string, w: number, name = ""): Line[] {
	const out: Line[] = [];
	let code = false;
	let first = true;
	for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (/^\s*```/.test(raw)) {
			code = !code;
			continue;
		}
		if (code) {
			out.push(...para(`  ${raw}`, w, "muted"));
			continue;
		}
		const h = raw.match(/^#{1,6}\s+(.*)$/);
		const lead = first && raw.trim() !== "";
		if (raw.trim()) first = false;
		if (
			h &&
			lead &&
			name &&
			h[1]!.trim().toLowerCase() === name.replace(/\.[a-z]+$/, "").toLowerCase()
		)
			continue;
		if (h) {
			if (out.length && !blank(out[out.length - 1])) out.push([]);
			out.push(
				...para(h[1]!, w, "strong").map((l) =>
					l.map((x) => ({ ...x, bold: true })),
				),
			);
			continue;
		}
		const b = raw.match(/^(\s*)[-*+]\s+(.*)$/);
		if (b) {
			const lines = wrap(b[2]!.replace(/`/g, ""), w - 2 - b[1]!.length);
			lines.forEach((t, i) =>
				out.push([g(i ? "  " : `${b[1]}• `, i ? "fg" : "muted"), g(t)]),
			);
			continue;
		}
		const n = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
		if (n) {
			const lab = `${n[1]}${n[2]}. `;
			wrap(n[3]!.replace(/`/g, ""), w - lab.length).forEach((t, i) =>
				out.push([
					g(i ? " ".repeat(lab.length) : lab, i ? "fg" : "muted"),
					g(t),
				]),
			);
			continue;
		}
		if (!raw.trim()) {
			if (out.length && !blank(out[out.length - 1])) out.push([]);
			continue;
		}
		out.push(...para(raw.replace(/`/g, ""), w));
	}
	while (out.length && blank(out[out.length - 1])) out.pop();
	return out;
}

function fileBlock(
	name: string,
	file: FileEntry | undefined,
	w: number,
): Line[] {
	const head: Line = [g(name, "strong", true)];
	if (!file || file.status === "loading")
		return [head, [g("loading…", "muted")]];
	if (file.status === "missing")
		return [head, [g(`not in the journal yet`, "muted")]];
	if (file.status === "error")
		return [head, [g(`couldn't read it: ${oneLine(file.message)}`, "cherry")]];
	return [head, ...markdown(file.text, w, name)];
}

// ───── Proof ─────

const ok = (pass: boolean): Seg =>
	pass ? g("✓ ", "amber") : g("✗ ", "cherry", true);
const info = g("· ", "muted");

function proofRows(bundle: ProofBundle, w: number): Line[] {
	const out: Line[] = [];
	const items = bundle.items;
	const before = items.find(
		(i): i is Extract<ProofItem, { kind: "repro_before" }> =>
			i.kind === "repro_before",
	);
	const after = items.find(
		(i): i is Extract<ProofItem, { kind: "repro_after" }> =>
			i.kind === "repro_after",
	);
	const add = (mark: Seg, label: string, value: string, tone: Tone = "fg") =>
		out.push(
			...fact(label, value, w - 2).map((l, i) => [
				i ? g("  ") : mark,
				...l.map((x, j) => (j ? { ...x, tone } : x)),
			]),
		);
	if (before || after)
		add(
			ok(!!before && !!after),
			"repro",
			before && after
				? `${oneLine(after.probe)} fails on base, passes on head`
				: before
					? `${oneLine(before.probe)} fails on base; no run on head yet`
					: `${oneLine(after!.probe)} passes on head`,
		);
	const probes = { regression: 0, intent: 0, failed: [] as string[] };
	for (const i of items) {
		switch (i.kind) {
			case "tests":
				add(
					ok(i.failed === 0 && i.newFailures === 0),
					"tests",
					`${i.passed} passed · ${i.failed} failed · ${i.newFailures} new`,
				);
				break;
			case "regression_probes":
				probes.regression += i.ran.length;
				probes.failed.push(...i.failed);
				break;
			case "intent_probes":
				probes.intent += i.ran.length;
				probes.failed.push(...i.failed);
				break;
			case "traffic_replay":
				add(
					ok(i.unexplained === 0),
					"replay",
					`${i.diffs} diffs · ${i.unexplained} unexplained`,
				);
				break;
			case "story_render":
			case "story_interaction":
				add(
					ok(i.failed.length === 0),
					"stories",
					`${i.stories.length} ${i.surface} · ${i.failed.length} failed`,
				);
				break;
			case "story_visual_diff":
				add(
					ok(i.changed.every((c) => i.explained.includes(c))),
					"visual",
					`${i.changed.length} changed · ${i.explained.length} explained`,
				);
				break;
			case "visual_approval":
				add(ok(true), "visuals", `approved by ${oneLine(i.by)}`);
				break;
			case "voxq_study":
				add(
					ok(i.expectMet),
					"people",
					`${i.respondents} respondents · ${i.expectMet ? "met" : "missed"} the expectation`,
				);
				break;
			case "persona_study":
				out.push(
					...fact(
						"personas",
						"synthetic, never counted as human proof",
						w - 2,
					).map((l, n) => [n ? g("  ") : info, ...l]),
				);
				break;
			case "trace":
				out.push(
					...fact(
						"trace",
						`${oneLine(i.traceId).slice(0, 12)} ${oneLine(i.note)}`,
						w - 2,
					).map((l, n) => [n ? g("  ") : info, ...l]),
				);
				break;
			default:
				break;
		}
	}
	if (probes.regression || probes.intent)
		add(
			ok(probes.failed.length === 0),
			"probes",
			`${probes.regression} regression · ${probes.intent} intent · ${probes.failed.length} failed`,
		);
	const diff = items.find(
		(i): i is Extract<ProofItem, { kind: "diff_scope" }> =>
			i.kind === "diff_scope",
	);
	if (diff) {
		out.push(
			...fact(
				"diff",
				`${diff.files} files · ${diff.lines} lines · exported types ${diff.exportedTypesChanged ? "changed" : "unchanged"}`,
				w - 2,
			).map((l, n) => [n ? g("  ") : info, ...l]),
		);
		// One path per line; a path too long for the column keeps its end, which is the part that identifies it.
		const room = w - 11;
		for (const p of diff.paths.map(oneLine))
			out.push([g("           "), g(width(p) <= room ? p : `…${tail(p, room - 1)}`, "muted")]);
	}
	const review = items.find(
		(i): i is Extract<ProofItem, { kind: "bug_review" }> =>
			i.kind === "bug_review",
	);
	if (review) {
		if (!review.findings.length)
			add(ok(true), "review", `no findings (${oneLine(review.reviewer)})`);
		for (const f of review.findings.slice(0, 3)) {
			const at = f.file
				? ` ${oneLine(f.file).split("/").pop()}${f.line ? `:${f.line}` : ""}`
				: "";
			const bad = f.severity === "high" || f.severity === "critical";
			out.push(
				...fact("review", `${f.severity}: ${oneLine(f.text)}${at}`, w - 2).map(
					(l, n) => [
						n ? g("  ") : g("! ", bad ? "cherry" : "mint", true),
						...l,
					],
				),
			);
		}
	}
	if (bundle.missing.length)
		out.push(
			...fact("missing", bundle.missing.join(", "), w - 2).map((l, n) => [
				n ? g("  ") : g("✗ ", "cherry", true),
				...l.map((x, j) => (j ? { ...x, tone: "cherry" as Tone } : x)),
			]),
		);
	return out;
}

// ───── The detail pane ─────

function meta(item: InboxItem): Line {
	const kind =
		item.kind === "checkpoint"
			? g(`checkpoint ${item.checkpoint}`, item.blocking ? "mint" : "strong", true)
			: item.kind === "spend"
				? g("spend", "mint", true)
				: g(item.kind, "mint", true);
	const what =
		item.kind === "checkpoint"
			? ({ A: "hypothesis", B: "plan", C: "proof" } as const)[
					item.checkpoint ?? "A"
				]
			: undefined;
	const parts = [
		what,
		item.blocking ? "blocking" : "advisory",
		`risk ${item.risk}`,
		`sev ${item.severity}`,
		oneLine(item.area),
	];
	return [
		kind,
		...parts
			.filter(Boolean)
			.flatMap((p) => [
				g(" · ", "dim"),
				g(p!, p === "blocking" ? "fg" : "muted"),
			]),
	];
}
/** Break a " · "-separated line at its separators so nothing is cut. */
function flow(line: Line, w: number): Line[] {
	const out: Line[] = [[]];
	let used = 0;
	for (let i = 0; i < line.length; i++) {
		const seg = line[i]!;
		const isSep = seg.text === " · ";
		const next = line[i + 1];
		const need =
			isSep && next ? width(seg.text) + width(next.text) : width(seg.text);
		if (isSep && used + need > w && used > 0) {
			out.push([]);
			used = 0;
			continue;
		}
		out[out.length - 1]!.push(seg);
		used += width(seg.text);
	}
	return out;
}

function activityLines(list: Activity[], w: number, max: number): Line[] {
	if (!list.length || max <= 0) return [];
	const out: Line[] = [[g("activity", "muted")]];
	for (const a of list.slice(-max)) {
		const tone: Tone =
			a.tone === "ok"
				? "amber"
				: a.tone === "bad"
					? "cherry"
					: a.tone === "human"
						? "strong"
						: "fg";
		const head = `${a.at.slice(11, 16)} ${trunc(a.who, 10).padEnd(10)} `;
		const lines = wrap(oneLine(a.text), Math.max(8, w - head.length));
		lines
			.slice(0, 2)
			.forEach((t, i) =>
				out.push([g(i ? " ".repeat(head.length) : head, "muted"), g(t, tone)]),
			);
	}
	return out;
}

function landingLines(story: TrailStory, trail: Trail, w: number): Line[] {
	const out: Line[] = [];
	for (const r of story.landings.slice(-1))
		out.push(
			...fact(
				"landed",
				`${MODE[r.mode]} → ${oneLine(r.target)} ${r.newOid.slice(0, 7)}`,
				w,
			).map((l) => l.map((x, j) => (j ? { ...x, tone: "amber" as Tone } : x))),
		);
	if (!story.landings.length && trail.landing)
		out.push(
			...fact(
				"lands as",
				`${trail.landing.modes.map((m) => MODE[m]).join(" or ")} → ${oneLine(trail.landing.target)}`,
				w,
			),
		);
	if (story.watch && !story.rollback) {
		const wcfg = story.watch;
		const prints = wcfg.fingerprints.length;
		const what = [
			duration(wcfg.windowS),
			`${prints} fingerprint${prints === 1 ? "" : "s"}`,
			`${wcfg.areaProbes.length} probes`,
		].join(" · ");
		out.push(...fact("watch", story.watchClean ? `${what} · clean` : what, w));
	}
	if (story.regressed)
		out.push(
			...fact("regressed", oneLine(story.regressed.criterion), w).map((l) =>
				l.map((x, j) => (j ? { ...x, tone: "cherry" as Tone } : x)),
			),
		);
	if (story.rollback)
		out.push(
			...fact(
				"undone",
				`${MODE[story.rollback.mode]} → ${oneLine(story.rollback.target)} ${story.rollback.newOid.slice(0, 7)}`,
				w,
			).map((l) => l.map((x, j) => (j ? { ...x, tone: "cherry" as Tone } : x))),
		);
	if (story.stage >= STAGES.length)
		out.push(
			...fact("set", "its repro now runs as a regression probe", w).map((l) =>
				l.map((x, j) => (j ? { ...x, tone: "amber" as Tone } : x)),
			),
		);
	return out;
}

/** The body for one trail: what's being asked, and what the trail has to show for it. */
function trailBody(
	story: TrailStory,
	trail: Trail,
	ask: InboxItem["kind"] | "trail",
	checkpoint: "A" | "B" | "C" | undefined,
	artefact: FileEntry | undefined,
	summary: string,
	w: number,
): Line[] {
	const out: Line[] = [];
	const t = story.triage;
	// For a trail that has landed, where it is now comes first: the landing, the watch, any rollback.
	const landed = landingLines(story, trail, w);
	if (ask === "trail" && story.landings.length) out.push(...landed, []);
	if (ask === "checkpoint" && checkpoint === "A") {
		out.push(...fileBlock("hypothesis.md", artefact, w), []);
	}
	if (ask === "checkpoint" && checkpoint === "B") {
		if (story.repro)
			out.push(
				...fact(
					"repro",
					story.repro.ok
						? `${oneLine(story.repro.probe ?? "probe")} fails on base`
						: `not reproduced: ${oneLine(story.repro.reason ?? "")}`,
					w - 2,
				).map((l, i) => [i ? g("  ") : ok(story.repro!.ok), ...l]),
			);
		out.push([], ...fileBlock("plan.md", artefact, w), []);
	}
	if (
		(ask === "checkpoint" && checkpoint === "C") ||
		(ask === "trail" && story.proof)
	) {
		if (story.proof) {
			const b = story.proof.bundle;
			out.push([
				g("proof", "strong", true),
				g(`  rev ${b.rev} · `, "muted"),
				b.passed ? g("passed", "amber", true) : g("failed", "cherry", true),
				g(` · ${b.items.length} items`, "muted"),
			]);
			out.push(...proofRows(b, w), []);
		} else
			out.push(
				[
					g("proof", "strong", true),
					g(`  none for rev ${story.rev} yet`, "muted"),
				],
				[],
			);
	}
	if (ask === "spend") {
		const sp = story.spend;
		out.push(
			...fact(
				"spend",
				sp
					? `${oneLine(sp.purpose)} · up to ${usd(sp.microusd)}`
					: oneLine(summary),
				w,
			).map((l) => l.map((x, j) => (j ? { ...x, tone: "mint" as Tone } : x))),
		);
		out.push(
			...fact(
				"budget",
				`${usd(trail.budget.spendMicrousdUsed)} of ${usd(trail.budget.spendMicrousdMax)} spent on this quest`,
				w,
			),
		);
		out.push(
			...para(
				"a approves this spend only. Anything more asks again.",
				w,
				"muted",
			),
			[],
		);
	}
	if (ask === "parked" || ask === "notice") {
		out.push(...fact("why", oneLine(summary), w));
		out.push(
			...para(
				ask === "parked"
					? "p resumes it · t takes it over · x kills it"
					: "c to reply · t to take it over",
				w,
				"muted",
			),
			[],
		);
	}
	if (t && (ask === "trail" || (ask === "checkpoint" && checkpoint === "A"))) {
		const flags = [
			t.duplicateOf ? `duplicate of ${oneLine(t.duplicateOf)}` : "no duplicate",
			t.regressionOf ? `regression of ${oneLine(t.regressionOf)}` : undefined,
			t.conflictsWith
				? `conflicts with ${oneLine(t.conflictsWith)}`
				: undefined,
		]
			.filter(Boolean)
			.join(" · ");
		out.push(
			...fact(
				"triage",
				`${t.route.replace("_", " ")} · actionable ${Math.round(t.actionable * 100)}% · ${flags}`,
				w,
			),
		);
		out.push(
			...fact("decided", oneLine(t.backends.decide), w).map((l) =>
				l.map((x, j) => (j ? { ...x, tone: "muted" as Tone } : x)),
			),
		);
		out.push(
			...fact(
				"evidence",
				`${story.occurrences} signal${story.occurrences === 1 ? "" : "s"} · e explains`,
				w,
			),
			[],
		);
	}
	if (landed.length && ((ask === "trail" && !story.landings.length) || checkpoint === "C"))
		out.push(...landed, []);
	return out;
}

function detailLines(
	state: InboxState,
	item: InboxItem,
	entry: DetailEntry | undefined,
	w: number,
	rows: number,
): Line[] {
	const out: Line[] = [];
	out.push(
		...para(oneLine(item.title), w, "strong")
			.slice(0, 2)
			.map((l) => l.map((x) => ({ ...x, bold: true }))),
	);
	out.push(...flow(meta(item), w));
	if (item.shadowVerdict)
		out.push([
			g("policy, in shadow mode, would ", "muted"),
			g(item.shadowVerdict, "strong", true),
		]);
	out.push([]);
	if (!entry || entry.status === "loading") {
		out.push(
			...railLines(itemRail(item), w),
			[],
			[g("loading the quest…", "muted")],
			[],
			...para(oneLine(item.artefact.summary), w, "muted"),
		);
		return out;
	}
	if (entry.status === "error") {
		out.push(
			...railLines(itemRail(item), w),
			[],
			[g(`couldn't load the quest: ${oneLine(entry.message)}`, "cherry")],
		);
		return out;
	}
	const story = trailStory(entry.trail, entry.events);
	out.push(...railLines(rail(story), w), []);
	out.push(
		...trailBody(
			story,
			entry.trail,
			item.kind,
			item.checkpoint,
			entry.artefact,
			item.artefact.summary,
			w,
		),
	);
	out.push(
		...activityLines(story.activity, w, Math.max(3, rows - out.length - 1)),
	);
	void state;
	return out;
}

function evidenceLines(
	item: InboxItem,
	entry: DetailEntry | undefined,
	w: number,
): Line[] {
	const out: Line[] = [
		[
			g("explain", "strong", true),
			g(`  what ${item.short} is based on`, "muted"),
		],
		[],
	];
	const file = entry?.status === "ready" ? entry.evidence : undefined;
	if (!file || file.status === "loading")
		return [...out, [g("loading evidence/index.json…", "muted")]];
	if (file.status === "error")
		return [
			...out,
			[
				g(
					`couldn't read the evidence index: ${oneLine(file.message)}`,
					"cherry",
				),
			],
		];
	if (file.status === "missing") {
		out.push(
			...para(
				"No evidence index in this quest's journal yet. The agent writes one when it researches.",
				w,
				"muted",
			),
		);
		if (entry?.status === "ready") {
			out.push(
				[],
				...fact("signals", `${entry.trail.signals.length} linked`, w),
			);
			if (entry.trail.signalFingerprint)
				out.push(...fact("print", oneLine(entry.trail.signalFingerprint), w));
		}
		return out;
	}
	let hits:
		| {
				source?: unknown;
				title?: unknown;
				snippet?: unknown;
				score?: unknown;
				revision?: unknown;
		  }[]
		| undefined;
	try {
		const parsed = JSON.parse(file.text) as unknown;
		const list = Array.isArray(parsed)
			? parsed
			: (parsed as { hits?: unknown })?.hits;
		if (Array.isArray(list)) hits = list as typeof hits;
	} catch {
		hits = undefined;
	}
	if (!hits) return [...out, ...para(file.text, w)];
	if (!hits.length) return [...out, [g("The index is empty.", "muted")]];
	for (const h of hits.slice(0, 40)) {
		const src = oneLine(String(h.source ?? "?"));
		const score = typeof h.score === "number" ? ` ${h.score.toFixed(2)}` : "";
		out.push(
			spread(
				[g(src.padEnd(8), "strong"), g(oneLine(String(h.title ?? "")), "fg")],
				[g(score, "muted")],
				w,
			),
		);
		if (h.snippet)
			for (const t of wrap(oneLine(String(h.snippet)), w - 8).slice(0, 2))
				out.push([g("        "), g(t, "muted")]);
	}
	return out;
}

export const KEYS: [string, string][] = [
	["j k", "move between items"],
	["g G", "jump to the first or the last item"],
	["a", "approve the checkpoint or the spend; at C, this lands it"],
	["r", "send it back with a note"],
	["x", "kill the quest, with a reason"],
	["c", "comment; everyone on the quest sees it"],
	["t", "claim a checkpoint review, so nobody decides it under you"],
	["u", "release a review you claimed; do this before deciding"],
	["p", "park it, or resume it"],
	["o", "open the landing or the agent's thread"],
	["l", "land a ready quest whose proof is approved"],
	["e", "explain: the evidence behind it"],
	["J K", "scroll this pane"],
	["R", "refresh from the server now (it also refreshes every 30 s)"],
	["d", "show the documentation page for what is selected"],
	["esc", "back to the quest"],
	["q", "quit"],
];
function helpLines(w: number): Line[] {
	return [
		[g("keys", "strong", true)],
		[],
		...KEYS.flatMap(([k, v]) =>
			wrap(v, w - 8).map((t, i) => [
				g(i ? "        " : k.padEnd(8), "key", !i),
				g(t),
			]),
		),
		[],
		...para(
			"Every decision is bound to the revision you saw. If the quest changed underneath you, it's refused and the item refreshes.",
			w,
			"muted",
		),
		[],
		[g("tips", "strong", true)],
		[],
		...TIPS.flatMap((tip) => [...para(tip, w), []]),
		[g("docs    ", "key", true), g(docsBase(), "fg")],
		[g("        "), g("EPHYRA_TIPS=0 hides the tip line; NO_COLOR is honoured by the other commands", "muted")],
	];
}

/** Things worth knowing that no key label can say. Shown under the keys. */
export const TIPS: readonly string[] = [
	"Read before you approve: e opens the evidence a checkpoint rests on, and J/K scroll it. An approval says you read this revision.",
	"Colour is state. Mint is waiting on you, amber is work that holds, cherry is a failure or an undo.",
	"Approving checkpoint C is what lands the quest. l is only for a ready quest whose proof was approved earlier.",
	"A note with r goes to the agent, which works on it and comes back to the same checkpoint. x ends the quest for good.",
	"Everything here is also a command: ephyra show, decide, runs, usage. Add --json to script it, or run ephyra help.",
	"Nothing waiting does not mean nothing is happening. ephyra quests lists every quest; ephyra activity shows the agents at work.",
];

/**
 * One line under the panes when nothing else needs the space: the most useful thing to know about what is selected.
 * Clauses are separated by " · ", most useful first; a narrow terminal shows as many whole clauses as fit.
 */
export function tipFor(state: InboxState): string | undefined {
	if (state.tips === false || state.modal) return undefined;
	const item = state.items[state.selected];
	const pane = state.pane ?? "detail";
	if (pane === "help") return undefined;
	if (!item) return "ephyra quests lists every quest, waiting or not · ephyra doctor checks the setup · R refreshes";
	if (pane === "evidence") return "e returns to the quest · J K scroll · a source marked unavailable is a gap, not a pass";
	if (item.state === "handed_off") return "you hold this review · u releases it so it can be decided";
	if (item.kind === "spend") return "a approves this one spend · x stops the quest · to decline and continue: ephyra spend <quest> reject";
	if (item.state === "parked") return "p resumes it where it stopped · the reason it parked is in the activity below";
	if (item.kind === "checkpoint" && item.checkpoint === "A") return "e shows the evidence behind this hypothesis · r sends it back with a note · d opens the reviewing guide";
	if (item.kind === "checkpoint" && item.checkpoint === "B") return "the repro should fail for the reason the hypothesis gives · r sends the plan back with a note";
	if (item.kind === "checkpoint" && item.checkpoint === "C") return "approving lands this exact revision · if the quest changes first, the approval is refused";
	if (item.state === "ready") return "l lands it: the proof is already approved · e shows what the proof covers";
	return "? lists every key · d shows the docs page for this";
}

// ───── Header, hints, messages ─────

function header(state: InboxState, w: number): Line {
	const blocking = state.items.filter((i) => i.blocking).length;
	const left: Line = [g(" ephyra", "amber", true), g(" · inbox", "muted")];
	const right: Line = state.items.length
		? [
				g(`${state.items.length} waiting`, "fg"),
				g(" · ", "dim"),
				g(`${blocking} blocking`, blocking ? "mint" : "muted"),
				g(" "),
			]
		: [g("all clear ", "muted")];
	return row(spread(left, right, w), w);
}

const HINTS: [string, string][] = [
	["a", "approve"],
	["r", "revise"],
	["l", "land"],
	["e", "explain"],
	["o", "open"],
	["t", "take"],
	["c", "comment"],
	["p", "park"],
	["x", "kill"],
	["q", "quit"],
];
function hints(state: InboxState, w: number): Line {
	if (state.modal)
		return row(
			[
				g(" "),
				g("enter", "key", true),
				g(" send  ", "muted"),
				g("esc", "key", true),
				g(" cancel", "muted"),
			],
			w,
		);
	const item = state.items[state.selected];
	const can = availableKeys(item);
	const out: Line = [g(" ")];
	const reserve = "? keys  ".length;
	let used = 1;
	for (const [k, label] of HINTS) {
		if (!can.has(k) || k === "?") continue;
		const lab =
			k === "a" && item?.kind === "checkpoint" && item.checkpoint === "C"
				? "approve and land"
				: k === "p" && item?.state === "parked"
					? "resume"
					: label;
		const cost = k.length + 1 + lab.length + 2;
		if (used + cost > w - reserve) break;
		const waiting = k === "a" && item?.blocking;
		out.push(g(k, waiting ? "mint" : "key", true), g(` ${lab}  `, "muted"));
		used += cost;
	}
	if (item?.state === "handed_off" && used + "u release  ".length <= w - reserve)
		out.push(g("u", "key", true), g(" release  ", "muted"));
	out.push(g("?", "key", true), g(" keys  ", "muted"));
	return row(out, w);
}

function message(state: InboxState, w: number): Line {
	const item = state.items[state.selected];
	if (state.modal) {
		const prefix = ` ${state.modal.action} ${item?.short ?? ""} › `;
		const room = Math.max(1, w - width(prefix) - 1);
		const note = oneLine(state.modal.value);
		const shown = width(note) > room ? `…${tail(note, room - 1)}` : note;
		return row([g(prefix, "strong", true), g(shown), g("▏", "strong")], w);
	}
	if (state.error)
		return row(
			[g(" ✗ ", "cherry", true), g(oneLine(state.error), "cherry")],
			w,
		);
	if (state.notice)
		return row([g(" "), g(oneLine(state.notice), "strong")], w);
	// A tip is whole clauses or nothing: half a sentence under a checkpoint is worse than none.
	const clauses = tipFor(state)?.split(" · ") ?? [];
	let tip = "";
	for (const clause of clauses) {
		const next = tip ? `${tip} · ${clause}` : clause;
		if (width(next) > w - 6) break;
		tip = next;
	}
	return tip ? row([g(" tip ", "dim", true), g(tip, "dim")], w) : row([], w);
}

// ───── The whole screen ─────

export function inboxView(state: InboxState, w = 80, h = 24): Line[] {
	w = Math.max(40, Math.floor(w));
	h = Math.max(10, Math.floor(h));
	const item = state.items[state.selected];
	const entry = item ? state.details?.[detailKey(item)] : undefined;
	const pane = state.pane ?? "detail";
	const bodyH = h - 3;
	const rightTitle: Line =
		pane === "help"
			? [g("keys", "muted")]
			: item
				? [
						g(item.short, "strong", true),
						g(pane === "evidence" ? " · explain" : "", "muted"),
					]
				: [g("inbox", "muted")];
	const right = (rw: number, rows: number): Line[] => {
		if (pane === "help") return helpLines(rw);
		if (!item)
			return [
				[],
				...para("Nothing needs you right now.", rw, "fg"),
				[],
				...para(
					"Loose edges land and watch themselves. Items appear here when autonomy.md says a person decides.",
					rw,
					"muted",
				),
				[],
				[g("While you wait", "strong", true)],
				[g("ephyra quests    ", "key", true), g("every quest and its state", "muted")],
				[g("ephyra activity  ", "key", true), g("what the agents are doing", "muted")],
				[g("ephyra setup     ", "key", true), g("what is blocking the loop, if anything", "muted")],
				[g("ephyra doctor    ", "key", true), g("check this machine and repository", "muted")],
				[],
				...para(`Expected something here? ${docsFor(undefined).replace(/terminal$/, "troubleshooting")}`, rw, "muted"),
			];
		if (pane === "evidence") return evidenceLines(item, entry, rw);
		return detailLines(state, item, entry, rw, rows);
	};
	const lines: Line[] = [header(state, w)];
	if (w >= 80) {
		const lw = Math.max(30, Math.min(44, Math.round(w * 0.34)));
		const rw = w - lw - 1;
		const left = box(
			[g("waiting", "muted")],
			listLines(state, lw - 2, bodyH - 2),
			lw,
			bodyH,
			listScroll(state, bodyH - 2),
			false,
		);
		const r = box(
			rightTitle,
			right(rw - 2, bodyH - 2),
			rw,
			bodyH,
			state.scroll ?? 0,
			true,
		);
		for (let i = 0; i < bodyH; i++) lines.push([...left[i]!, g(" "), ...r[i]!]);
	} else if (w < 60) {
		// Under 60 columns the selected item gets the whole screen: reading the checkpoint matters more than the
		// list. The title says where it sits in the list, and j/k move.
		const pos = state.items.length ? ` · ${state.selected + 1} of ${state.items.length}` : "";
		const title: Line = pane === "help" ? rightTitle : [...rightTitle, g(pos, "muted")];
		lines.push(...box(title, right(w - 2, bodyH - 2), w, bodyH, state.scroll ?? 0, true));
	} else {
		const listH = Math.max(
			3,
			Math.min(state.items.length * 2 + 2, Math.floor(bodyH * 0.4)),
		);
		lines.push(
			...box(
				[g("waiting", "muted")],
				listLines(state, w - 2, listH - 2),
				w,
				listH,
				listScroll(state, listH - 2),
				false,
			),
		);
		lines.push(
			...box(
				rightTitle,
				right(w - 2, bodyH - listH - 2),
				w,
				bodyH - listH,
				state.scroll ?? 0,
				true,
			),
		);
	}
	lines.push(message(state, w), hints(state, w));
	return lines.map((l) => row(l, w));
}

/** Keep the selected item in view when the list is longer than its box. */
function listScroll(state: InboxState, rows: number): number {
	const per = state.items.length * 3 <= rows ? 3 : 2;
	const top = state.selected * per;
	return Math.max(0, top + 2 - rows);
}

// ───── `ephyra show` and `ephyra trails` ─────

/** One trail, full width, for `ephyra show`. Files are the journal's hypothesis.md and plan.md when fetched. */
export function trailView(
	trail: Trail,
	events: TrailEvent[],
	files: { hypothesis?: FileEntry; plan?: FileEntry },
	w = 80,
): Line[] {
	w = Math.max(40, Math.floor(w));
	const story = trailStory(trail, events);
	const out: Line[] = [];
	out.push(
		spread(
			[
				g(trail.short, "strong", true),
				g("  "),
				g(oneLine(trail.title), "strong", true),
			],
			[],
			w,
		),
	);
	out.push([
		g(
			trail.state.replace("_", " "),
			story.halted === "rolled_back" ? "cherry" : story.gate ? "mint" : "fg",
		),
		...[
			`risk ${trail.risk}`,
			`sev ${trail.severity}`,
			oneLine(trail.area),
			`rev ${trail.rev}`,
		]
			.filter(Boolean)
			.flatMap((p) => [g(" · ", "dim"), g(p, "muted")]),
	]);
	out.push([], ...railLines(rail(story), w), []);
	if (files.hypothesis && files.hypothesis.status !== "missing")
		out.push(...fileBlock("hypothesis.md", files.hypothesis, w), []);
	if (story.repro && !story.proof)
		out.push(
			...fact(
				"repro",
				story.repro.ok
					? `${oneLine(story.repro.probe ?? "probe")} fails on base`
					: `not reproduced: ${oneLine(story.repro.reason ?? "")}`,
				w - 2,
			).map((l, i) => [i ? g("  ") : ok(story.repro!.ok), ...l]),
			[],
		);
	if (files.plan && files.plan.status !== "missing")
		out.push(...fileBlock("plan.md", files.plan, w), []);
	out.push(...trailBody(story, trail, "trail", undefined, undefined, "", w));
	out.push(...activityLines(story.activity, w, 8));
	return out.map((l) => row(l, w));
}

/** A table of trails for `ephyra trails`. */
export function trailsView(trails: Trail[], w = 80): Line[] {
	w = Math.max(40, Math.floor(w));
	if (!trails.length) return [[g("No quests.", "muted")]];
	const head = [
		g("quest     ", "muted"),
		g("state         ", "muted"),
		g("area          ", "muted"),
		g("risk     ", "muted"),
		g("title", "muted"),
	];
	return [
		row(head, w),
		...trails.map((t) => {
			const s = trailStory(t, []);
			const tone: Tone =
				t.state === "rolled_back" || t.state === "abandoned"
					? "cherry"
					: s.gate || t.state === "parked"
						? "mint"
						: t.state === "closed"
							? "muted"
							: "fg";
			return row(
				[
					g(t.short.padEnd(10), "strong"),
					g(t.state.replace("_", " ").padEnd(14), tone),
					g(trunc(oneLine(t.area), 13).padEnd(14), "muted"),
					g(t.risk.padEnd(9), "muted"),
					g(oneLine(t.title)),
				],
				w,
			);
		}),
	];
}
