// Renders the inbox at each moment of the example trail into JSON for the landing page's walkthrough, so the
// site shows the real screen, not a drawing of it. The data is the example trail in src/inbox/demo.ts.
// usage: bun run scripts/walkthrough.ts <out.json> [cols] [rows]
import { writeFileSync } from "node:fs";
import {
	DEMO_FILES,
	DEMO_ITEMS,
	DEMO_OTHERS,
	DEMO_ROLLBACK,
	DEMO_TEXT,
	KEYS,
	PALETTE,
	demoTrail,
	detailKey,
	inboxReducer,
	inboxView,
	trailView,
	type DemoMoment,
	type FileEntry,
	type InboxState,
	type Line,
} from "../src/index";
import type { InboxItem } from "@ephyra/core";

const [out = "walkthrough.json", colsArg = "96", rowsArg = "30"] = process.argv.slice(2);
const W = Number(colsArg);
const H = Number(rowsArg);
const file = (path: string): FileEntry =>
	DEMO_FILES[path] ? { status: "ready", text: DEMO_FILES[path]! } : { status: "missing" };
const at = (item: InboxItem, moment: DemoMoment, extra: Partial<InboxState> = {}): InboxState => ({
	items: [item, ...DEMO_OTHERS],
	selected: 0,
	details: { [detailKey(item)]: { status: "ready", ...demoTrail(moment), artefact: file(item.artefact.path) } },
	...extra,
});
/** Lines as [text, tone, bold?] triples: compact, and the page maps tones to its own colours. */
const pack = (lines: Line[]) => lines.map((l) => l.map((s) => (s.bold ? [s.text, s.tone ?? "fg", 1] : [s.text, s.tone ?? "fg"])));
const screen = (state: InboxState, w = W, h = H) => pack(inboxView(state, w, h));
/** Pad a free-height view (ephyra show) to the screen's size, cutting what doesn't fit. */
/** A command's output in a shell: the prompt and command, the output, then the next prompt. Cut to h rows. */
const page = (command: string, lines: Line[], w = W, h = H) => {
	const blank = (l: Line) => l.every((x) => !x.text.trim());
	const output = [...lines];
	while (output.length && blank(output[output.length - 1]!)) output.pop();
	const pad = (l: Line): Line => {
		const used = l.reduce((n, x) => n + x.text.length, 0);
		return used < w ? [...l, { text: " ".repeat(w - used) }] : l;
	};
	const prompt = (rest: Line): Line => pad([{ text: "$ ", tone: "muted", bold: true }, ...rest]);
	const rows: Line[] = [prompt([{ text: command, tone: "strong" }]), pad([]), ...output.slice(0, h - 4).map(pad), pad([])];
	rows.push(prompt([{ text: "▏", tone: "strong" }]));
	while (rows.length < h) rows.push(pad([]));
	return pack(rows.slice(0, h));
};

const evidence = (() => {
	let s = at(DEMO_ITEMS.A, "hypothesis");
	s = inboxReducer(s, "e").state;
	const k = detailKey(DEMO_ITEMS.A);
	const e = s.details![k]!;
	if (e.status === "ready") s.details![k] = { ...e, evidence: file("evidence/index.json") };
	return s;
})();
const revising = (() => {
	let s = at(DEMO_ITEMS.A, "hypothesis");
	s = inboxReducer(s, "r").state;
	for (const ch of "check the coupon path too") s = inboxReducer(s, ch).state;
	return s;
})();
const show = (moment: DemoMoment, w: number, h: number) => {
	const d = demoTrail(moment);
	return page("ephyra show T-4c1e0f", trailView(d.trail, d.events, {}, w), w, h);
};
const rolledBack = (w: number, h: number) =>
	page("ephyra show T-738495", trailView(DEMO_ROLLBACK.trail, DEMO_ROLLBACK.events, {}, w), w, h);

/**
 * The walkthrough's steps, in order. Each has the real screen at two sizes: `wide` for desktops (W×H) and `narrow`
 * for phones (40 columns; the inbox's narrow, detail-first layout). `key` is what's pressed to arrive here.
 */
type Step = { id: string; command: string; key: string | null; wide: unknown; narrow: unknown };
// Phones get the narrow layout at 40 columns (about 13px type), tall enough that nothing is cut off: the page
// shows a window onto it and pans to what each step is about.
const NW = 40;
const NH = 56;
const inbox = (s: InboxState) => ({ wide: screen(s), narrow: screen(s, NW, NH) });
const steps: Step[] = [
	{ id: "triaged", command: "ephyra show T-4c1e0f", key: null, wide: show("triaged", W, H), narrow: show("triaged", NW, NH) },
	{ id: "hypothesis", command: "ephyra inbox", key: null, ...inbox(at(DEMO_ITEMS.A, "hypothesis")) },
	{ id: "explain", command: "ephyra inbox", key: "e", ...inbox(evidence) },
	{ id: "revise", command: "ephyra inbox", key: "r", ...inbox(revising) },
	{ id: "plan", command: "ephyra inbox", key: "a", ...inbox(at(DEMO_ITEMS.B, "plan")) },
	{ id: "proof", command: "ephyra inbox", key: "a", ...inbox(at(DEMO_ITEMS.C, "proof")) },
	{ id: "watching", command: "ephyra show T-4c1e0f", key: "a", wide: show("watching", W, H), narrow: show("watching", NW, NH) },
	{ id: "set", command: "ephyra show T-4c1e0f", key: null, wide: show("set", W, H), narrow: show("set", NW, NH) },
	{ id: "rollback", command: "ephyra show T-738495", key: null, wide: rolledBack(W, H), narrow: rolledBack(NW, NH) },
];

// Both presentations use the same moment of the same fixture, including the separate rollback example.
const guiMoments: Record<string, ReturnType<typeof demoTrail>> = Object.fromEntries(steps.map(({ id }) => {
	const moment = id === "explain" || id === "revise" ? "hypothesis" : id;
	return [id, moment === "rollback" ? DEMO_ROLLBACK : demoTrail(moment as DemoMoment)];
}));

const data = {
	note: "Generated by apps/cli/scripts/walkthrough.ts from the CLI's real view and its example trail. Sample data.",
	cols: W,
	rows: H,
	narrowCols: NW,
	palette: PALETTE,
	keys: KEYS,
	autonomy: DEMO_TEXT.autonomy,
	gui: { moments: guiMoments, hypothesis: DEMO_TEXT.hypothesis, plan: DEMO_TEXT.plan, evidence: JSON.parse(DEMO_TEXT.evidence) },
	steps,
};
writeFileSync(out, `${JSON.stringify(data)}\n`);
console.log(`${out}: ${steps.length} steps at ${W}×${H} and ${NW} columns`);
