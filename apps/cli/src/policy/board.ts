// The policy board: autonomy.md as one row per area, with a five-step level meter. Pure: `ephyra policy` prints
// it, `ephyra policy edit` drives it with keys, and the tests read the same lines. The raw document stays one key
// away (`e`), and every change goes through the parser the server uses, so the board never shows a policy the
// document does not say.
import { AUTONOMY_LEVELS, type AreaSketch, type AutonomyLevel } from "@ephyra/core";
import {
	applySketches,
	parseAutonomy,
	renderAutonomy,
	sketchesOf,
	type Area,
	type AutonomyPolicy,
} from "@ephyra/policy";
import { oneLine, tail, trunc, width, wrap } from "../inbox/text";
import { row, type Line, type Seg, type Tone } from "../inbox/view";

const g = (text: string, tone: Tone = "fg", bold = false): Seg =>
	bold ? { text, tone, bold } : { text, tone };

export const RISKS = ["low", "medium", "high", "critical"] as const;
export const LEVEL_IDS = AUTONOMY_LEVELS.map((l) => l.id);
const AREA_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const RISK_TONE: Record<AreaSketch["risk"], Tone> = {
	low: "muted",
	medium: "fg",
	high: "amber",
	critical: "cherry",
};

export const levelLabel = (level: AutonomyLevel) =>
	AUTONOMY_LEVELS.find((l) => l.id === level)!.label;
const levelMeans = (level: AutonomyLevel) =>
	AUTONOMY_LEVELS.find((l) => l.id === level)!.means.replace(/\btrails\b/g, "quests");

/** Five pips, filled up to the level: ●●●○○ for Propose. */
export function meter(level: AutonomyLevel): Line {
	const n = LEVEL_IDS.indexOf(level) + 1;
	return [
		g("●".repeat(n), n === LEVEL_IDS.length ? "mint" : "amber"),
		g("○".repeat(LEVEL_IDS.length - n), "dim"),
	];
}

/** What changed for one area between the published map and the edited one. */
export type Change = "new" | "changed" | undefined;
export function changeOf(original: readonly AreaSketch[], sketch: AreaSketch): Change {
	const was = original.find((o) => o.name === sketch.name);
	if (!was) return "new";
	return JSON.stringify(normal(was)) === JSON.stringify(normal(sketch)) ? undefined : "changed";
}
const normal = (s: AreaSketch) => ({
	name: s.name,
	intent: s.intent.trim(),
	paths: s.paths,
	risk: s.risk,
	level: s.level,
	userFacing: s.userFacing,
	studyBudgetUsd: s.studyBudgetUsd ?? null,
});
export function changes(original: readonly AreaSketch[], next: readonly AreaSketch[]) {
	const edited = next.filter((s) => changeOf(original, s)).map((s) => s.name);
	const removed = original.filter((o) => !next.some((s) => s.name === o.name)).map((o) => o.name);
	return { edited, removed, count: edited.length + removed.length };
}

function pathSummary(paths: readonly string[], w: number): string {
	if (!paths.length) return "no paths";
	const all = paths.join(", ");
	if (width(all) <= w) return all;
	const more = ` +${paths.length - 1}`;
	return paths.length > 1 ? trunc(oneLine(paths[0]!), Math.max(4, w - more.length)) + more : trunc(all, w);
}

const nameWidth = (sketches: readonly AreaSketch[]) =>
	Math.min(22, Math.max(6, ...sketches.map((s) => width(s.name)))) + 2;

/** One area as one line. `mark` is the gutter: the cursor in the board, a change mark in a listing. */
export function areaRow(
	sketch: AreaSketch,
	opts: { w: number; nameW: number; selected?: boolean; change?: Change },
): Line {
	const gutter = opts.selected ? g("› ", "mint", true) : g("  ");
	const change =
		opts.change === "new" ? g("+ ", "mint") : opts.change === "changed" ? g("~ ", "amber") : g("  ");
	const left: Line = [
		gutter,
		change,
		g(trunc(oneLine(sketch.name), opts.nameW - 1).padEnd(opts.nameW), "strong", Boolean(opts.selected)),
		g(sketch.risk.padEnd(10), RISK_TONE[sketch.risk]),
		...meter(sketch.level),
		g(` ${levelLabel(sketch.level).padEnd(11)}`, opts.selected ? "strong" : "fg"),
	];
	const used = left.reduce((n, s) => n + width(s.text), 0);
	const room = opts.w - used;
	return row(room >= 8 ? [...left, g(pathSummary(sketch.paths, room), "muted")] : left, opts.w);
}

export const STOPS = { A: "cause", B: "plan", C: "landing" } as const;
/** Who decides in an area, in a sentence, from the settings it really has. */
export function approves(real: { mode: "shadow" | "enforce"; asks: readonly ("A" | "B" | "C")[]; landing: readonly string[]; watch: string }): string {
	if (real.mode === "shadow") return "Ephyra only reports here; nothing is done without you";
	const yours = real.asks.map((c) => `the ${STOPS[c]}`);
	if (!yours.length)
		return real.landing.includes("auto_land") ? `nothing waits for you; watched ${real.watch} after landing` : "nothing waits for you";
	return `you approve ${yours.length > 1 ? `${yours.slice(0, -1).join(", ")} and ${yours.at(-1)}` : yours[0]}`;
}

/** One line that sums the map up, from the sketches alone. */
export function summary(sketches: readonly AreaSketch[]): string {
	if (!sketches.length) return "no areas";
	const auto = sketches.filter((s) => s.level === "auto").length;
	const critical = sketches.filter((s) => s.risk === "critical").length;
	return [
		`${sketches.length} area${sketches.length === 1 ? "" : "s"}`,
		...(auto ? [`${auto} land${auto === 1 ? "s" : ""} by ${auto === 1 ? "itself" : "themselves"}`] : []),
		...(critical ? [`${critical} critical`] : []),
	].join(" · ");
}

/** The map as a compact listing, for `ephyra policy`. */
export function mapView(sketches: readonly AreaSketch[], w: number, original?: readonly AreaSketch[]): Line[] {
	const nameW = nameWidth(sketches);
	const out: Line[] = [
		[g("    "), g("area".padEnd(nameW), "muted"), g("risk".padEnd(10), "muted"), g("autonomy".padEnd(17), "muted"), g("paths", "muted")],
	];
	for (const s of sketches)
		out.push(areaRow(s, { w, nameW, ...(original ? { change: changeOf(original, s) } : {}) }));
	if (!sketches.length) out.push([g("    none yet. `ephyra policy add <area>` starts one.", "muted")]);
	if (original)
		for (const name of changes(original, sketches).removed)
			out.push([g("  - ", "cherry"), g(oneLine(name), "muted"), g("  removed", "cherry")]);
	return out.map((l) => row(l, w));
}

/** The settings an area really has in a document: its own, falling back to the defaults. Read from the parser, never guessed from the level. */
export function effective(policy: AutonomyPolicy, name: string) {
	const area: Area | undefined = policy.areas.find((a) => a.name === name);
	if (!area) return undefined;
	const d = policy.defaults;
	const asks = (["A", "B", "C"] as const).filter((c) => (area.overrides[c] ?? d.checkpoints[c]) === "blocking");
	return {
		mode: area.mode ?? d.mode,
		asks,
		landing: area.landing ?? d.landing,
		watch: area.watch ?? d.watch,
	};
}

// ───────────────────────── the interactive board ─────────────────────────

type TextModal = { kind: "paths" | "intent" | "new"; value: string };
export type Modal = TextModal | { kind: "publish" } | { kind: "quit" };
const isText = (modal: Modal): modal is TextModal => "value" in modal;
export type BoardState = {
	/** The policy as published: what "changed" is measured against, and what `z` puts back. */
	original: AreaSketch[];
	/** The document as the server last held it for this session: the open draft's text, or the published one. */
	start: string;
	/** The document as edited. Equal to `start` until something changes. */
	text: string;
	/** True once the raw document was edited by hand: the save then sends the text, not the map. */
	raw: boolean;
	selected: number;
	modal?: Modal;
	notice?: string;
	error?: string;
	help?: boolean;
	/** The draft on the server, if there is one: open, or published and waiting to be activated. */
	draft?: { id: string; status: "open" | "published" };
	busy?: string;
};
export type BoardCommand = { action: "save" | "publish" | "raw" | "quit" };

const safeSketches = (text: string): AreaSketch[] => {
	try {
		return sketchesOf(parseAutonomy(text));
	} catch {
		return [];
	}
};
export const boardSketches = (state: BoardState): AreaSketch[] => safeSketches(state.text);
/** Edits not yet saved to the draft. */
export const unsaved = (state: BoardState) => state.text !== state.start;
const sameMap = (a: readonly AreaSketch[], b: readonly AreaSketch[]) =>
	JSON.stringify(a.map(normal)) === JSON.stringify(b.map(normal));

export function initialBoard(input: {
	/** The published document. */
	published: string;
	/** An open draft of it, if one exists: editing continues there. */
	draft?: { id: string; content: string };
}): BoardState {
	const start = input.draft?.content ?? input.published;
	return {
		original: safeSketches(input.published),
		start,
		text: start,
		raw: false,
		selected: 0,
		...(input.draft ? { draft: { id: input.draft.id, status: "open" as const } } : {}),
	};
}

/** Apply an edited map to the document, the same way the server does. An error leaves the document alone and says why. */
function withMap(state: BoardState, next: AreaSketch[], selected = state.selected): BoardState {
	try {
		const { policy } = applySketches(parseAutonomy(state.text), next);
		// Back to the map that was saved: keep that text rather than a re-rendered copy of it, so nothing counts as unsaved.
		const text = !state.raw && sameMap(safeSketches(state.start), next) ? state.start : renderAutonomy(policy);
		return {
			...state,
			text,
			selected: Math.max(0, Math.min(selected, next.length - 1)),
			error: undefined,
			notice: undefined,
		};
	} catch (error) {
		return { ...state, error: oneLine(error instanceof Error ? error.message : "That edit was refused").slice(0, 200), notice: undefined };
	}
}

export function boardReducer(state: BoardState, key: string): { state: BoardState; command?: BoardCommand } {
	if (state.busy) return { state };
	const sketches = boardSketches(state);
	const current = sketches[state.selected];
	const edit = (patch: Partial<AreaSketch>) =>
		current ? withMap(state, sketches.map((s) => (s === current ? { ...s, ...patch } : s))) : state;
	const modal = state.modal;
	if (modal) {
		if (key === "escape") return { state: { ...state, modal: undefined } };
		if (!isText(modal)) {
			if (key === "y" || key === "Y")
				return { state: { ...state, modal: undefined }, command: { action: modal.kind } };
			return { state: { ...state, modal: undefined } };
		}
		if (key === "backspace")
			return { state: { ...state, modal: { ...modal, value: Array.from(modal.value).slice(0, -1).join("") } } };
		if (key === "return") {
			const value = modal.value.trim();
			const closed = { ...state, modal: undefined };
			if (modal.kind === "new") {
				if (!AREA_NAME.test(value))
					return { state: { ...state, error: "Area names are lowercase letters, numbers and dashes." } };
				if (sketches.some((s) => s.name === value))
					return { state: { ...state, error: "That area already exists." } };
				return {
					state: withMap(
						closed,
						[...sketches, { name: value, intent: "", paths: [], risk: "medium", level: "research", userFacing: false }],
						sketches.length,
					),
				};
			}
			if (!current) return { state: closed };
			const patch: Partial<AreaSketch> =
				modal.kind === "paths"
					? { paths: value.split(",").map((p: string) => p.trim()).filter(Boolean) }
					: { intent: value };
			return { state: withMap(closed, sketches.map((s) => (s === current ? { ...s, ...patch } : s))) };
		}
		return {
			state: key.length === 1 || Array.from(key).length === 1
				? { ...state, error: undefined, modal: { ...modal, value: modal.value + key } }
				: state,
		};
	}
	if (key === "?") return { state: { ...state, help: !state.help } };
	if (key === "escape") return { state: { ...state, help: false, notice: undefined, error: undefined } };
	if (key === "j" || key === "down" || key === "k" || key === "up") {
		const step = key === "j" || key === "down" ? 1 : -1;
		return { state: { ...state, selected: Math.max(0, Math.min(sketches.length - 1, state.selected + step)) } };
	}
	if (key === "g") return { state: { ...state, selected: 0 } };
	if (key === "G") return { state: { ...state, selected: Math.max(0, sketches.length - 1) } };
	if (key === "q")
		return unsaved(state) ? { state: { ...state, modal: { kind: "quit" } } } : { state, command: { action: "quit" } };
	if (key === "e") return { state, command: { action: "raw" } };
	if (key === "s")
		return unsaved(state)
			? { state, command: { action: "save" } }
			: { state: { ...state, notice: "Nothing to save.", error: undefined } };
	if (key === "P") {
		if (unsaved(state)) return { state: { ...state, error: "Save first (s), then publish.", notice: undefined } };
		if (state.draft?.status !== "open")
			return { state: { ...state, notice: "There is no open draft to publish.", error: undefined } };
		return { state: { ...state, modal: { kind: "publish" } } };
	}
	if (key === "n") return { state: { ...state, modal: { kind: "new", value: "" }, error: undefined } };
	if (key === "Z")
		return { state: { ...state, text: state.start, raw: false, selected: 0, notice: "Unsaved edits dropped.", error: undefined } };
	if (!current) return { state };
	if (key === "h" || key === "left" || key === "l" || key === "right") {
		const at = LEVEL_IDS.indexOf(current.level) + (key === "l" || key === "right" ? 1 : -1);
		const level = LEVEL_IDS[at];
		if (!level) return { state };
		if (level === "auto" && current.risk === "critical")
			return { state: { ...state, error: "A critical area never lands by itself. Patch is its highest level.", notice: undefined } };
		return { state: edit({ level }) };
	}
	if (/^[1-5]$/.test(key)) {
		const level = LEVEL_IDS[Number(key) - 1]!;
		if (level === "auto" && current.risk === "critical")
			return { state: { ...state, error: "A critical area never lands by itself. Patch is its highest level.", notice: undefined } };
		return { state: edit({ level }) };
	}
	if (key === "r") {
		const risk = RISKS[(RISKS.indexOf(current.risk) + 1) % RISKS.length]!;
		const next = edit({ risk });
		return {
			state: risk === "critical" && current.level === "auto" && !next.error
				? { ...next, notice: "Critical areas never land by themselves, so this one is now at Patch." }
				: next,
		};
	}
	if (key === "u") return { state: edit({ userFacing: !current.userFacing }) };
	if (key === "p") return { state: { ...state, modal: { kind: "paths", value: current.paths.join(", ") }, error: undefined } };
	if (key === "i") {
		if (current.intent.includes("\n"))
			return { state: { ...state, notice: "This description has several lines. Press e to edit it in the document.", error: undefined } };
		return { state: { ...state, modal: { kind: "intent", value: current.intent }, error: undefined } };
	}
	if (key === "D")
		return { state: withMap(state, sketches.filter((s) => s !== current)) };
	if (key === "z") {
		const was = state.original.find((o) => o.name === current.name);
		return {
			state: was
				? withMap(state, sketches.map((s) => (s === current ? was : s)))
				: { ...state, notice: "This area is new. D removes it.", error: undefined },
		};
	}
	return { state };
}

const KEYS: Array<[string, string]> = [
	["←/→", "level"],
	["r", "risk"],
	["p", "paths"],
	["i", "describe"],
	["n", "new"],
	["e", "raw"],
	["s", "save"],
	["P", "publish"],
	["?", "keys"],
	["q", "quit"],
];
const HELP: Array<[string, string]> = [
	["j k ↑ ↓", "move between areas (g first, G last)"],
	["← → h l", "one step down or up the ladder"],
	["1 … 5", "Watch, Research, Propose, Patch, Auto-land"],
	["r", "cycle risk: low, medium, high, critical"],
	["u", "user-facing or internal"],
	["p", "edit the paths (comma separated globs)"],
	["i", "describe the area in a sentence"],
	["n", "add an area"],
	["D", "remove the area"],
	["z", "put this area back as it is in effect"],
	["Z", "drop every unsaved edit"],
	["e", "edit the raw document in $EDITOR"],
	["s", "save to a draft (nothing is in effect yet)"],
	["P", "publish the draft (approvers only)"],
	["q", "quit"],
];

const MODAL_LABEL = { paths: "Paths", intent: "What this part is", new: "New area name" } as const;

/** The board as lines, exactly `h` rows of `w` columns. */
export function boardView(state: BoardState, w: number, h: number): Line[] {
	w = Math.max(40, w);
	const sketches = boardSketches(state);
	const delta = changes(state.original, sketches);
	const out: Line[] = [];
	const stateWord = unsaved(state)
		? g("unsaved edits", "amber")
		: state.draft?.status === "open"
			? g(`draft ${state.draft.id.slice(0, 8)} saved, not published`, "mint")
			: state.draft?.status === "published"
				? g("published, waiting to be activated", "mint")
				: g("as in effect", "muted");
	out.push([g(" ephyra policy", "strong", true), g("  autonomy.md  ", "muted"), stateWord]);
	out.push([
		g(` ${summary(sketches)}`, "muted"),
		...(delta.count ? [g(`  ·  ${delta.count} change${delta.count === 1 ? "" : "s"} from the policy in effect`, "amber")] : []),
	]);
	out.push([]);
	if (state.help) {
		for (const [key, what] of HELP) out.push([g(`  ${key.padEnd(10)}`, "key", true), g(what, "muted")]);
	} else {
		const nameW = nameWidth(sketches);
		out.push([g("    "), g("area".padEnd(nameW), "dim"), g("risk".padEnd(10), "dim"), g("autonomy".padEnd(17), "dim"), g("paths", "dim")]);
		// Leave room for the header (4), the detail (up to 8) and the footer (3).
		const room = Math.max(3, h - 4 - 9 - 3);
		const start = Math.max(0, Math.min(state.selected - Math.floor(room / 2), sketches.length - room));
		sketches.slice(start, start + room).forEach((s, i) =>
			out.push(areaRow(s, { w, nameW, selected: start + i === state.selected, change: changeOf(state.original, s) })),
		);
		if (sketches.length > start + room) out.push([g(`    … ${sketches.length - start - room} more`, "dim")]);
		if (!sketches.length) out.push([g("    No areas yet. Press n to add one.", "muted")]);
		for (const name of delta.removed) out.push([g("  - ", "cherry"), g(oneLine(name), "muted"), g("  removed", "cherry")]);
		out.push([]);
		out.push(...detail(state, sketches[state.selected], w));
	}
	const foot: Line[] = [];
	const modal = state.modal;
	if (modal?.kind === "publish")
		foot.push([g(" Publish this draft of autonomy.md? ", "strong", true), g("y", "key", true), g(" publishes, any other key cancels", "muted")]);
	else if (modal?.kind === "quit")
		foot.push([g(" Quit and drop unsaved edits? ", "strong", true), g("y", "key", true), g(" quits, any other key stays", "muted")]);
	else if (modal && isText(modal)) {
		const label = ` ${MODAL_LABEL[modal.kind]}: `;
		foot.push([g(label, "mint", true), g(tail(modal.value, w - label.length - 2)), g("▏", "mint")]);
	} else if (state.busy) foot.push([g(` ${state.busy}`, "muted")]);
	else if (state.error) foot.push([g(` ${oneLine(state.error)}`, "cherry")]);
	else if (state.notice) foot.push([g(` ${oneLine(state.notice)}`, "mint")]);
	else foot.push([]);
	const hint: Line = [g(" ")];
	if (modal && isText(modal)) hint.push(g("enter", "key", true), g(" keep  ", "muted"), g("esc", "key", true), g(" cancel", "muted"));
	else for (const [key, what] of KEYS) hint.push(g(key, "key", true), g(` ${what}  `, "muted"));
	foot.push(hint);
	const body = out.slice(0, Math.max(0, h - foot.length));
	while (body.length < h - foot.length) body.push([]);
	return [...body, ...foot].map((l) => row(l, w));
}

function detail(state: BoardState, sketch: AreaSketch | undefined, w: number): Line[] {
	if (!sketch) return [];
	const out: Line[] = [];
	const label = (text: string) => g(`  ${text.padEnd(9)}`, "dim");
	out.push([g("  "), g(oneLine(sketch.name), "strong", true), g(`  ${levelLabel(sketch.level)}: `, "amber"), g(levelMeans(sketch.level), "muted")]);
	let policy: AutonomyPolicy | undefined;
	try {
		policy = parseAutonomy(state.text);
	} catch {
		policy = undefined;
	}
	const real = policy && effective(policy, sketch.name);
	if (real) {
		// The three points a quest can wait at, by what is decided there (the file calls them A, B and C).
		const stops: Line = [label("you")];
		(["A", "B", "C"] as const).forEach((c, i) => {
			const yours = real.asks.includes(c);
			if (i) stops.push(g(" ── ", "dim"));
			stops.push(g(yours ? "● " : "○ ", yours ? "mint" : "dim"), g(STOPS[c], yours ? "strong" : "dim"));
		});
		stops.push(g(`   ${approves(real)}`, "muted"));
		out.push(stops);
		const facing = sketch.userFacing ? "   user-facing" : "   internal";
		out.push([label("lands"), g(real.landing.join(", ")), g(`   watched ${real.watch}`, "muted"), g(facing, "muted")]);
	}
	out.push([label("paths"), g(sketch.paths.length ? trunc(oneLine(sketch.paths.join(", ")), w - 12) : "none", sketch.paths.length ? "fg" : "muted")]);
	const intent = sketch.intent.trim();
	const wrapped = intent ? wrap(intent, w - 13) : ["No description yet. Press i to add one."];
	const lines = wrapped.length > 3 ? [...wrapped.slice(0, 2), trunc(`${wrapped[2]} …`, w - 13)] : wrapped;
	lines.forEach((text, i) => out.push([i === 0 ? label("about") : g(" ".repeat(11)), g(text, "muted")]));
	return out;
}
