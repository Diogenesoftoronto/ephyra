// `ephyra policy …`: see the policy as a compact map, change it with flags or on the interactive board, or open
// the raw document in $EDITOR. Every change goes into a draft on the server; publishing and activating are
// separate, explicit steps, and nothing here reports a write the server did not confirm.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { AUTONOMY_LEVELS, type AreaSketch, type AutonomyLevel, type PolicyActivationReceipt } from "@ephyra/core";
import { parseAutonomy } from "@ephyra/policy";
import { ApiError, type Client, type PolicyDocument, type PolicyDraft } from "../client";
import { toAnsi } from "../inbox/paint";
import { oneLine } from "../inbox/text";
import type { Line, Seg, Tone } from "../inbox/view";
import {
	LEVEL_IDS,
	RISKS,
	boardReducer,
	boardSketches,
	boardView,
	changes,
	initialBoard,
	levelLabel,
	mapView,
	summary,
	type BoardCommand,
	type BoardState,
} from "./board";

export const AUTONOMY_PATH = "autonomy.md";
export const POLICY_ACTIONS = ["show", "set", "add", "rm", "raw", "edit", "diff", "publish", "activate", "discard"] as const;

const g = (text: string, tone: Tone = "fg", bold = false): Seg =>
	bold ? { text, tone, bold } : { text, tone };

export type PolicyIo = {
	json: boolean;
	cols: number;
	paint: (lines: Line[]) => void;
	emit: (value: unknown) => void;
	usage: (message?: string) => Error;
	/** The active receipt and document list view the bare command has always printed. */
	receipt: (active: PolicyActivationReceipt | null, docs: PolicyDocument[]) => Line[];
	/** Open text in the person's editor and return what they saved. Injected so tests never start one. */
	editor?: (text: string, name: string) => Promise<string>;
	interactive?: boolean;
};

/** What a refusal means for someone changing policy. Never a response body. */
function explain(error: unknown): Error {
	if (!(error instanceof ApiError)) return error instanceof Error ? error : new Error("request failed");
	const said: Record<number, string> = {
		400: "The server refused that edit as invalid. `ephyra policy` shows the areas as they are.",
		403: "Only a signed-in approver can do that (`ephyra whoami`).",
		404: "The server has no such policy document or draft. `ephyra policy` shows what exists.",
		409: "The server refused: the document changed since the draft started, or the draft has errors. `ephyra policy diff` shows the draft.",
		422: "Policy activation is not configured on this server.",
	};
	return new Error(said[error.status] ?? error.message);
}
const guard = async <T>(run: () => Promise<T>): Promise<T> => {
	try {
		return await run();
	} catch (error) {
		throw explain(error);
	}
};

const openDraft = async (c: Client, path = AUTONOMY_PATH) =>
	(await c.drafts("open")).find((d) => d.path === path);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const short = (id: string) => id.slice(0, 8);
const errorsIn = (warnings: string[]) => warnings.filter((w) => w.startsWith("error:"));
const brokenWords = (broken: string[]) =>
	`has ${broken.length} error${broken.length === 1 ? "" : "s"} and cannot be published: ${oneLine(broken[0]!)}`;

function option(args: string[], ...names: string[]): string | undefined {
	for (const name of names) {
		const i = args.indexOf(name);
		if (i >= 0) {
			const value = args[i + 1];
			args.splice(i, value === undefined ? 1 : 2);
			return value;
		}
		const inline = args.findIndex((arg) => arg.startsWith(`${name}=`));
		if (inline >= 0) return args.splice(inline, 1)[0]!.slice(name.length + 1);
	}
	return undefined;
}
function flag(args: string[], name: string): boolean {
	const i = args.indexOf(name);
	if (i >= 0) args.splice(i, 1);
	return i >= 0;
}

/** The edits `set` and `add` take, read from flags. Unknown values are a usage mistake, never a guess. */
function patchFrom(args: string[], io: PolicyIo): Partial<AreaSketch> {
	const patch: Partial<AreaSketch> = {};
	const level = option(args, "--level");
	if (level !== undefined) {
		const found = AUTONOMY_LEVELS.find((l) => l.id === level.toLowerCase() || l.label.toLowerCase() === level.toLowerCase());
		if (!found) throw io.usage(`Unknown level “${oneLine(level)}”. Levels: ${LEVEL_IDS.join(", ")}.`);
		patch.level = found.id;
	}
	const risk = option(args, "--risk");
	if (risk !== undefined) {
		if (!(RISKS as readonly string[]).includes(risk)) throw io.usage(`Unknown risk “${oneLine(risk)}”. Risks: ${RISKS.join(", ")}.`);
		patch.risk = risk as AreaSketch["risk"];
	}
	const paths = option(args, "--paths");
	if (paths !== undefined) patch.paths = paths.split(",").map((p) => p.trim()).filter(Boolean);
	const about = option(args, "--about", "--intent");
	if (about !== undefined) patch.intent = about;
	const facing = flag(args, "--user-facing");
	const internal = flag(args, "--internal");
	if (facing && internal) throw io.usage("Pick one of --user-facing and --internal.");
	if (facing || internal) patch.userFacing = facing;
	return patch;
}

/** A unified-style line diff, small enough for policy documents. */
export function lineDiff(before: string, after: string): Array<{ sign: " " | "+" | "-"; text: string }> {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ sign: "-" as const, text })), ...b.map((text) => ({ sign: "+" as const, text }))];
	const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
	const out: Array<{ sign: " " | "+" | "-"; text: string }> = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) out.push({ sign: " ", text: a[i++]! }), j++;
		else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ sign: "-", text: a[i++]! });
		else out.push({ sign: "+", text: b[j++]! });
	}
	while (i < a.length) out.push({ sign: "-", text: a[i++]! });
	while (j < b.length) out.push({ sign: "+", text: b[j++]! });
	return out;
}
/** Changed lines with two lines of context around them. */
function diffView(before: string, after: string): Line[] {
	const all = lineDiff(before, after);
	const keep = new Set<number>();
	all.forEach((l, i) => {
		if (l.sign !== " ") for (let k = i - 2; k <= i + 2; k++) keep.add(k);
	});
	const out: Line[] = [];
	let last = -1;
	all.forEach((l, i) => {
		if (!keep.has(i)) return;
		if (last >= 0 && i > last + 1) out.push([g("  ⋯", "dim")]);
		last = i;
		out.push([g(`${l.sign} ${oneLine(l.text)}`, l.sign === "+" ? "mint" : l.sign === "-" ? "cherry" : "muted")]);
	});
	return out;
}

const draftLine = (draft: PolicyDraft, live: PolicyDocument): Line[] => {
	const delta = changes(live.sketches ?? [], draft.sketches ?? []);
	const broken = errorsIn(draft.warnings).length;
	const what = delta.count
		? `${delta.count} area${delta.count === 1 ? "" : "s"} changed`
		: draft.content === live.content ? "no changes yet" : "text changed";
	return [
		[
			g("draft          ", "muted"),
			g(short(draft.id), "amber", true),
			g(
				`  ${what}, not published`,
				"muted",
			),
			...(broken ? [g(`  ${broken} error${broken === 1 ? "" : "s"}`, "cherry")] : []),
		],
		[g("               ", "muted"), g("`ephyra policy diff` shows it; `ephyra policy publish` publishes it.", "dim")],
	];
};

export async function policyCommand(c: Client, args: string[], io: PolicyIo): Promise<void> {
	const action = args[0] && !args[0].startsWith("-") ? args.shift()! : "show";
	if (!(POLICY_ACTIONS as readonly string[]).includes(action)) throw io.usage();

	if (action === "show") {
		if (args.length) throw io.usage();
		const [active, docs] = await Promise.all([c.policyActive(), c.policyDocs()]);
		const live = docs.find((d) => d.path === AUTONOMY_PATH);
		// The draft is extra: a server that cannot list drafts still shows its policy.
		const draft = await openDraft(c).catch(() => undefined);
		if (io.json)
			return io.emit({
				active,
				documents: docs.map(({ path, kind, digest, warnings }) => ({ path, kind, digest, warnings })),
				areas: live?.sketches ?? [],
				draft: draft ? { id: draft.id, areas: draft.sketches ?? [], warnings: draft.warnings } : null,
			});
		const lines: Line[] = [];
		if (live?.sketches) {
			lines.push([g("areas          ", "muted"), g(summary(live.sketches), "strong")], []);
			lines.push(...mapView(live.sketches, Math.max(40, io.cols)), []);
		}
		lines.push(...io.receipt(active, docs));
		if (draft && live) lines.push([], ...draftLine(draft, live));
		if (live?.sketches)
			lines.push([], [g("Change it: `ephyra policy edit` (board), `ephyra policy set <area> --level patch`, `ephyra policy edit --raw`.", "dim")]);
		return io.paint(lines);
	}

	if (action === "raw") {
		const fromDraft = flag(args, "--draft");
		const path = args.shift() ?? AUTONOMY_PATH;
		if (args.length) throw io.usage();
		const text = fromDraft
			? (await guard(() => openDraft(c, path)))?.content
			: (await guard(() => c.policyDoc(path))).content;
		if (text === undefined) throw new Error(`There is no open draft of ${oneLine(path)}.`);
		// The document itself, byte for byte, so it can be piped into a file or an editor.
		if (io.json) return io.emit({ path, content: text });
		process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
		return;
	}

	if (action === "diff") {
		if (args.length) throw io.usage();
		const [live, draft] = await guard(() => Promise.all([c.policyDoc(AUTONOMY_PATH), openDraft(c)]));
		if (io.json) return io.emit(draft ? { draft: draft.id, before: live.sketches ?? [], after: draft.sketches ?? [], warnings: draft.warnings } : null);
		if (!draft) return io.paint([[g("No open draft. The policy is as shown by `ephyra policy`.", "muted")]]);
		const lines: Line[] = [[g(`draft ${short(draft.id)}  `, "amber", true), g(`${AUTONOMY_PATH}, not published`, "muted")], []];
		if (draft.sketches && live.sketches) lines.push(...mapView(draft.sketches, Math.max(40, io.cols), live.sketches), []);
		const text = diffView(live.content, draft.content);
		lines.push(...(text.length ? text : [[g("The draft has the same text as the policy in effect.", "muted")]]));
		for (const w of draft.warnings.slice(0, 8)) lines.push([g(`  ${oneLine(w)}`, w.startsWith("error:") ? "cherry" : "muted")]);
		return io.paint(lines);
	}

	if (action === "set" || action === "add" || action === "rm") {
		const name = args.shift();
		if (!name || name.startsWith("-")) throw io.usage();
		const patch = action === "rm" ? {} : patchFrom(args, io);
		if (args.length) throw io.usage();
		if (action === "set" && !Object.keys(patch).length)
			throw io.usage("Nothing to change. Give at least one of --level, --risk, --paths, --about, --user-facing, --internal.");
		const live = await guard(() => c.policyDoc(AUTONOMY_PATH));
		const existing = await guard(() => openDraft(c));
		const before = existing?.sketches ?? live.sketches;
		if (!before) throw new Error("The autonomy document has errors, so it has no map to edit. `ephyra policy edit --raw` opens the text.");
		const at = before.findIndex((s) => s.name === name);
		if (action === "add" && at >= 0) throw new Error(`Area ${oneLine(name)} already exists. \`ephyra policy set ${oneLine(name)} …\` changes it.`);
		if (action !== "add" && at < 0)
			throw new Error(`No area named ${oneLine(name)}. Areas: ${before.map((s) => s.name).join(", ") || "none"}.`);
		if (action === "add" && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(name)) throw io.usage("Area names are lowercase letters, numbers and dashes.");
		const base: AreaSketch = at >= 0 ? before[at]! : { name, intent: "", paths: [], risk: "medium", level: "research", userFacing: false };
		const edited: AreaSketch = { ...base, ...patch };
		if (edited.level === "auto" && edited.risk === "critical")
			throw new Error("A critical area never lands by itself. Patch is its highest level.");
		const next =
			action === "rm" ? before.filter((s) => s.name !== name)
			: action === "add" ? [...before, edited]
			: before.map((s) => (s.name === name ? edited : s));
		const draft = existing ?? (await guard(() => c.createDraft(AUTONOMY_PATH)));
		const saved = await guard(() => c.setDraftSketches(draft, next));
		if (io.json) return io.emit({ draft: saved.id, areas: saved.sketches ?? [], warnings: saved.warnings });
		const lines: Line[] = [...mapView(saved.sketches ?? next, Math.max(40, io.cols), live.sketches ?? []), []];
		const broken = errorsIn(saved.warnings);
		lines.push([g(`Saved to draft ${short(saved.id)}. `, "mint"), g("Nothing is in effect yet.", "muted")]);
		if (broken.length) lines.push([g(`The draft ${brokenWords(broken)}`, "cherry")]);
		lines.push([g("Next: `ephyra policy diff` to read it, `ephyra policy publish` to publish, `ephyra policy discard` to drop it.", "dim")]);
		return io.paint(lines);
	}

	if (action === "publish" || action === "discard") {
		if (args.length) throw io.usage();
		const draft = await guard(() => openDraft(c));
		if (!draft) throw new Error("There is no open draft of autonomy.md.");
		const done = await guard(() => c.draftAction(draft.id, action));
		if (io.json) return io.emit({ draft: done.id, status: done.status, published: done.published ?? null });
		if (action === "discard") return io.paint([[g(`Draft ${short(done.id)} discarded. `, "mint"), g("The policy in effect did not change.", "muted")]]);
		return io.paint([
			[g(`Published ${done.published ? done.published.commit.slice(0, 12) : short(done.id)}. `, "mint"), g("It is not in effect until it is activated.", "muted")],
			[g("Next: `ephyra policy activate`.", "dim")],
		]);
	}

	if (action === "activate") {
		if (args.length) throw io.usage();
		const [published, active] = await guard(() => Promise.all([c.drafts("published"), c.policyActive()]));
		const draft = published
			.filter((d) => d.path === AUTONOMY_PATH && d.published)
			.sort((a, b) => b.published!.at.localeCompare(a.published!.at))[0];
		if (!draft?.published) throw new Error("There is no published draft of autonomy.md to activate. `ephyra policy publish` comes first.");
		if (active?.draftId === draft.id) {
			if (io.json) return io.emit(active);
			return io.paint([[g(`Already in effect: ${active.commit.slice(0, 12)}.`, "muted")]]);
		}
		const receipt = await guard(() =>
			c.activateDraft(draft.id, {
				expectedCommit: draft.published!.commit,
				expectedDigest: sha256(draft.content),
				expectedActive: active?.commit ?? null,
			}),
		);
		if (io.json) return io.emit(receipt);
		return io.paint([[g(`In effect: ${receipt.commit.slice(0, 12)}. `, "mint"), g(`From draft ${short(draft.id)}.`, "muted")]]);
	}

	// edit
	const raw = flag(args, "--raw");
	const path = raw ? (args.shift() ?? AUTONOMY_PATH) : AUTONOMY_PATH;
	if (args.length) throw io.usage();
	if (io.json || !io.interactive)
		throw io.usage("`ephyra policy edit` needs a terminal. `ephyra policy set <area> --level …` changes one area without one.");
	const edit = io.editor ?? editInEditor;
	const [live, existing] = await guard(() => Promise.all([c.policyDoc(path), openDraft(c, path)]));
	if (raw) {
		const before = existing?.content ?? live.content;
		const after = await edit(before, path.split("/").at(-1)!);
		if (after === before) return io.paint([[g("No changes.", "muted")]]);
		const draft = existing ?? (await guard(() => c.createDraft(path)));
		const saved = await guard(() => c.setDraftContent(draft, after));
		const broken = errorsIn(saved.warnings);
		return io.paint([
			[g(`Saved to draft ${short(saved.id)}. `, "mint"), g("Nothing is in effect yet.", "muted")],
			...saved.warnings.slice(0, 8).map((w): Line => [g(`  ${oneLine(w)}`, w.startsWith("error:") ? "cherry" : "muted")]),
			[g(broken.length ? "Fix the errors (`ephyra policy edit --raw`) before publishing." : "Next: `ephyra policy diff`, then `ephyra policy publish`.", "dim")],
		]);
	}
	if (!live.sketches && !existing?.sketches)
		throw new Error("The autonomy document has errors, so it has no map to edit. `ephyra policy edit --raw` opens the text.");
	await runBoard(c, initialBoard({ published: live.content, ...(existing ? { draft: { id: existing.id, content: existing.content } } : {}) }), existing, edit);
}

/** Open text in $VISUAL or $EDITOR and return what was saved. The file lives in a private temporary directory and is removed after. */
export async function editInEditor(text: string, name: string): Promise<string> {
	const editor = process.env.VISUAL || process.env.EDITOR;
	if (!editor) throw new Error("Set $EDITOR to edit the raw document, or pipe it: `ephyra policy raw > autonomy.md`.");
	const dir = await mkdtemp(join(tmpdir(), "ephyra-policy-"));
	const file = join(dir, name.replace(/[^A-Za-z0-9._-]/g, "_") || "policy.md");
	try {
		await writeFile(file, text, { mode: 0o600 });
		// $EDITOR may carry arguments ("code -w"), so the shell splits it; the path is passed as an argument, never spliced in.
		const proc = Bun.spawn(["sh", "-c", `${editor} "$1"`, "ephyra-editor", file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
		if ((await proc.exited) !== 0) throw new Error("The editor exited with an error, so nothing was changed.");
		return await readFile(file, "utf8");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const DEFINITE = new Set([400, 401, 403, 404, 409, 422]);
/** A refusal the server was clear about is said as such; anything else may have happened and is reported as unknown. */
const failed = (error: unknown, what: string) =>
	error instanceof ApiError && DEFINITE.has(error.status)
		? explain(error).message
		: `${what} failed or its outcome is unknown. Check \`ephyra policy\` before retrying.`;

/** Run one board command against the server. Returns the next state; never claims a write that was not confirmed. */
export async function performBoard(
	c: Client,
	state: BoardState,
	command: BoardCommand,
	ctx: { draft?: PolicyDraft; edit: (text: string, name: string) => Promise<string> },
): Promise<{ state: BoardState; draft?: PolicyDraft; quit?: boolean }> {
	const keep = ctx.draft ? { draft: ctx.draft } : {};
	if (command.action === "quit") return { state, ...keep, quit: true };
	if (command.action === "raw") {
		try {
			const text = await ctx.edit(state.text, AUTONOMY_PATH);
			if (text === state.text) return { state: { ...state, notice: "No changes.", error: undefined }, ...keep };
			const notes = parseAutonomy(text).warnings.length;
			const next: BoardState = { ...state, text, raw: true, error: undefined, notice: undefined };
			return {
				state: {
					...next,
					selected: Math.max(0, Math.min(state.selected, boardSketches(next).length - 1)),
					notice: `Document edited${notes ? `, with ${notes} parser note${notes === 1 ? "" : "s"}` : ""}. s saves it to the draft.`,
				},
				...keep,
			};
		} catch (error) {
			return { state: { ...state, error: error instanceof Error ? error.message : "The editor could not be opened.", notice: undefined }, ...keep };
		}
	}
	if (command.action === "save") {
		try {
			const draft = ctx.draft?.status === "open" ? ctx.draft : await c.createDraft(AUTONOMY_PATH);
			const saved = state.raw ? await c.setDraftContent(draft, state.text) : await c.setDraftSketches(draft, boardSketches(state));
			const broken = errorsIn(saved.warnings);
			return {
				draft: saved,
				state: {
					...state,
					start: saved.content,
					text: saved.content,
					raw: false,
					draft: { id: saved.id, status: "open" },
					...(broken.length
						? { error: `Saved, but the draft ${brokenWords(broken)}`, notice: undefined }
						: { notice: `Saved to draft ${short(saved.id)}. P publishes it; nothing is in effect yet.`, error: undefined }),
				},
			};
		} catch (error) {
			return { state: { ...state, error: failed(error, "Saving"), notice: undefined }, ...keep };
		}
	}
	// publish
	if (!ctx.draft) return { state: { ...state, error: "There is no open draft to publish." } };
	try {
		const done = await c.draftAction(ctx.draft.id, "publish");
		return {
			draft: done,
			state: {
				...state,
				draft: { id: done.id, status: "published" },
				notice: `Published ${done.published ? done.published.commit.slice(0, 12) : short(done.id)}. It takes effect after \`ephyra policy activate\`.`,
				error: undefined,
			},
		};
	} catch (error) {
		return { state: { ...state, error: failed(error, "Publishing"), notice: undefined }, ...keep };
	}
}

const SCREEN_ON = "\x1b[?1049h\x1b[?25l";
const SCREEN_OFF = "\x1b[?25h\x1b[?1049l";

async function runBoard(
	c: Client,
	initial: BoardState,
	existing: PolicyDraft | undefined,
	edit: (text: string, name: string) => Promise<string>,
): Promise<void> {
	let state = initial;
	let draft = existing;
	const out = process.stdout;
	const draw = () => out.write(`\x1b[H\x1b[2J${toAnsi(boardView(state, out.columns || 80, out.rows || 24))}`);
	const enter = () => {
		out.write(SCREEN_ON);
		process.stdin.setRawMode(true);
		process.stdin.resume();
	};
	const leave = () => {
		process.stdin.setRawMode(false);
		process.stdin.pause();
		out.write(SCREEN_OFF);
	};
	emitKeypressEvents(process.stdin);
	enter();
	out.on("resize", draw);
	draw();
	let working = false;
	try {
		await new Promise<void>((resolve) => {
			const onKey = async (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
				if (key.ctrl && key.name === "c") return resolve();
				if (working) return;
				const input = ["return", "enter", "escape", "backspace", "up", "down", "left", "right"].includes(key.name ?? "")
					? key.name === "enter" ? "return" : key.name!
					: (text ?? "");
				if (!input) return;
				const result = boardReducer(state, input);
				state = result.state;
				draw();
				if (!result.command) return;
				working = true;
				const inEditor = result.command.action === "raw";
				if (inEditor) leave();
				else {
					state = { ...state, busy: result.command.action === "save" ? "Saving…" : result.command.action === "publish" ? "Publishing…" : undefined };
					draw();
				}
				const done = await performBoard(c, { ...state, busy: undefined }, result.command, { ...(draft ? { draft } : {}), edit });
				if (inEditor) enter();
				state = done.state;
				draft = done.draft;
				working = false;
				if (done.quit) return resolve();
				draw();
			};
			process.stdin.on("keypress", onKey);
		});
	} finally {
		out.off("resize", draw);
		process.stdin.removeAllListeners("keypress");
		leave();
	}
	const delta = changes(initial.original, boardSketches(state)).count;
	if (state.draft)
		console.log(
			state.draft.status === "published"
				? "Published. `ephyra policy activate` puts it into effect."
				: `Draft ${short(state.draft.id)} holds ${delta} changed area${delta === 1 ? "" : "s"} (${levelWords(boardSketches(state))}). `
					+ "`ephyra policy publish` publishes it.",
		);
}

const levelWords = (sketches: AreaSketch[]) => {
	const counts = new Map<AutonomyLevel, number>();
	for (const s of sketches) counts.set(s.level, (counts.get(s.level) ?? 0) + 1);
	return LEVEL_IDS.filter((l) => counts.has(l)).map((l) => `${counts.get(l)} ${levelLabel(l)}`).join(", ");
};
