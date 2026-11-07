import { ApiError, Client } from "../client";
import {
	detailKey,
	inboxReducer,
	type Command,
	type DetailEntry,
	type FileEntry,
	type InboxState,
} from "./reducer";
import { toAnsi, toStyled, type StyledKit } from "./paint";
import { inboxView } from "./view";
import { emitKeypressEvents } from "node:readline";

/** Journal files the server will serve (mirrors the server's isReadableFile; the server decides). */
const NAMES = new Set([
	"hypothesis.md",
	"plan.md",
	"intent.md",
	"evidence/index.json",
	"proof/manifest.json",
]);
const ARTEFACT =
	/^artefacts\/[a-z][a-z_-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const readable = (path: string) =>
	!path.includes("..") && (NAMES.has(path) || ARTEFACT.test(path));

/** Commands that change a trail on the server; the list is refreshed after each. */
const CHANGES = new Set([
	"approve",
	"revise",
	"kill",
	"park",
	"resume",
	"claim",
	"land",
	"comment",
]);

/** Errors shown to the person: never a response body, which could carry secrets. */
const say = (error: unknown) =>
	error instanceof ApiError
		? error.message
		: error instanceof Error && error.message === "API connection failed"
			? error.message
			: "request failed";

export async function execute(client: Client, cmd: Command) {
	const { item, action, note } = cmd;
	if (action === "approve" && item.kind === "spend")
		return client.spend(item.trailId, "approve");
	if (action === "approve" || action === "revise")
		return client.action(item.trailId, "decide", {
			checkpoint: item.checkpoint,
			verdict: action === "approve" ? "approve" : "revise",
			...(note ? { note } : {}),
		});
	if (action === "open") {
		if (!item.landingUrl) throw new Error("Landing URL unavailable");
		const url = new URL(item.landingUrl);
		if (!["http:", "https:"].includes(url.protocol))
			throw new Error("Unsupported landing URL");
		const program = process.platform === "darwin" ? "open" : "xdg-open";
		const proc = Bun.spawn([program, url.href], {
			stdout: "ignore",
			stderr: "ignore",
		});
		if ((await proc.exited) !== 0)
			throw new Error("Could not open landing URL");
		return `Opened ${url.host}`;
	}
	if (action === "evidence") return undefined; // the pane switches in the reducer; loadDetail fetches it
	return client.action(
		item.trailId,
		action,
		action === "comment"
			? { text: note }
			: action === "kill"
				? { reason: note }
				: {},
	);
}

/**
 * Fill in what the detail pane needs for the selected item: the trail and its events, the checkpoint's file
 * (hypothesis.md, plan.md, …) and, once `e` is pressed, the evidence index. Each is fetched once per revision.
 */
export async function loadDetail(
	client: Client,
	get: () => InboxState,
	set: (s: InboxState) => void,
): Promise<void> {
	const first = get();
	const item = first.items[first.selected];
	if (!item) return;
	const key = detailKey(item);
	const put = (fn: (e: DetailEntry | undefined) => DetailEntry | undefined) => {
		const s = get();
		const next = fn(s.details?.[key]);
		if (next) set({ ...s, details: { ...s.details, [key]: next } });
	};
	const putFile = (which: "artefact" | "evidence", file: FileEntry) =>
		put((e) => (e?.status === "ready" ? { ...e, [which]: file } : e));
	const fetchFile = async (which: "artefact" | "evidence", path: string) => {
		if (!readable(path)) return putFile(which, { status: "missing" });
		putFile(which, { status: "loading" });
		try {
			const text = await client.file(item.trailId, path);
			putFile(
				which,
				text === null ? { status: "missing" } : { status: "ready", text },
			);
		} catch (error) {
			putFile(which, { status: "error", message: say(error) });
		}
	};
	if (!first.details?.[key]) {
		put(() => ({ status: "loading" }));
		try {
			const d = await client.detail(item.trailId);
			put(() => ({ status: "ready", trail: d.trail, events: d.events }));
		} catch (error) {
			put(() => ({ status: "error", message: say(error) }));
			return;
		}
		if (item.kind === "checkpoint")
			await fetchFile("artefact", item.artefact.path);
	}
	const now = get();
	const entry = now.details?.[key];
	if (now.pane === "evidence" && entry?.status === "ready" && !entry.evidence)
		await fetchFile("evidence", item.evidenceIndex ?? "evidence/index.json");
}

/** Forget details for items that left the inbox, so a long session doesn't grow without bound. */
function prune(state: InboxState): InboxState {
	if (!state.details) return state;
	const live = new Set(state.items.map(detailKey));
	const details = Object.fromEntries(
		Object.entries(state.details).filter(([k]) => live.has(k)),
	);
	return { ...state, details };
}

export async function terminal(client: Client) {
	let state: InboxState = { items: await client.inbox(), selected: 0 };
	if (process.env.EPHYRA_ANSI === "1") return ansiTerminal(client, state);
	let tui: typeof import("@opentui/core");
	try {
		tui = await import("@opentui/core");
	} catch {
		return ansiTerminal(client, state);
	}
	const { createCliRenderer, TextRenderable } = tui;
	let renderer: Awaited<ReturnType<typeof createCliRenderer>>;
	try {
		renderer = await createCliRenderer({ exitOnCtrlC: true });
	} catch {
		return ansiTerminal(client, state);
	}
	const kit = tui as unknown as StyledKit;
	const frame = () =>
		toStyled(
			kit,
			inboxView(state, renderer.width, renderer.height),
		) as InstanceType<typeof tui.StyledText>;
	const view = new TextRenderable(renderer, {
		content: frame(),
		width: "100%",
		height: "100%",
	});
	renderer.root.add(view);
	const draw = () => {
		view.content = frame();
	};
	const load = () =>
		void loadDetail(
			client,
			() => state,
			(next) => {
				state = next;
				draw();
			},
		);
	let busy = false;
	const refresh = async () => {
		if (busy || state.modal) return;
		try {
			const items = await client.inbox();
			state = prune({
				...state,
				items,
				selected: Math.max(0, Math.min(state.selected, items.length - 1)),
				error: undefined,
			});
		} catch {
			state = { ...state, error: "Refresh failed" };
		}
		draw();
		load();
	};
	const timer = setInterval(refresh, 30000);
	renderer.on?.("resize", draw);
	load();
	renderer.keyInput.on("keypress", async (key) => {
		if (busy) return;
		if (key.name === "q" && !state.modal) {
			clearInterval(timer);
			renderer.destroy();
			return;
		}
		const name = key.name === "enter" ? "return" : key.name;
		const input = ["return", "escape", "backspace", "up", "down"].includes(name)
			? name
			: key.sequence;
		const result = inboxReducer(state, input);
		state = result.state;
		draw();
		load();
		if (!result.command || busy) return;
		busy = true;
		state = await runCommand(client, state, result.command, (next) => {
			state = next;
			draw();
		});
		busy = false;
		draw();
		// The server is the truth: after a change, show its list now rather than at the next 30 s tick.
		if (!state.error && CHANGES.has(result.command.action)) void refresh();
		else load();
	});
}

async function ansiTerminal(
	client: Client,
	initial: InboxState,
): Promise<void> {
	let state = initial;
	let busy = false;
	const draw = () => {
		process.stdout.write(
			`\x1b[2J\x1b[H${toAnsi(inboxView(state, process.stdout.columns || 80, process.stdout.rows || 24))}`,
		);
	};
	const load = () =>
		void loadDetail(
			client,
			() => state,
			(next) => {
				state = next;
				draw();
			},
		);
	const refresh = async () => {
		if (busy || state.modal) return;
		try {
			const items = await client.inbox();
			state = prune({
				...state,
				items,
				selected: Math.max(0, Math.min(state.selected, items.length - 1)),
				error: undefined,
			});
		} catch {
			state = { ...state, error: "Refresh failed" };
		}
		draw();
		load();
	};
	emitKeypressEvents(process.stdin);
	if (!process.stdin.isTTY) throw new Error("Inbox requires a terminal");
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdout.on("resize", draw);
	draw();
	load();
	const timer = setInterval(refresh, 30000);
	await new Promise<void>((resolve) => {
		process.stdin.on(
			"keypress",
			async (text: string, key: { name: string; ctrl?: boolean }) => {
				if (
					(key.name === "q" && !state.modal) ||
					(key.ctrl && key.name === "c")
				) {
					clearInterval(timer);
					process.stdout.off("resize", draw);
					process.stdin.setRawMode(false);
					process.stdin.pause();
					resolve();
					return;
				}
				if (busy) return;
				const input = ["return", "escape", "backspace", "up", "down"].includes(
					key.name,
				)
					? key.name
					: text;
				const result = inboxReducer(state, input);
				state = result.state;
				draw();
				load();
				if (!result.command) return;
				busy = true;
				state = await runCommand(client, state, result.command, (next) => {
					state = next;
					draw();
				});
				busy = false;
				draw();
				if (!state.error && CHANGES.has(result.command.action)) void refresh();
				else load();
			},
		);
	});
}

/** Applies a reversible local update while the server processes a command. */
export async function runCommand(
	client: Client,
	state: InboxState,
	cmd: Command,
	update: (state: InboxState) => void,
): Promise<InboxState> {
	const before = state;
	if (
		["approve", "revise", "kill", "park", "resume", "claim", "land"].includes(
			cmd.action,
		)
	) {
		const items = state.items.filter((item) => item !== cmd.item);
		state = {
			...state,
			items,
			selected: Math.max(0, Math.min(state.selected, items.length - 1)),
			error: undefined,
			notice: undefined,
			pane: "detail",
			scroll: 0,
		};
		update(state);
	}
	try {
		const result = await execute(client, cmd);
		if (cmd.action === "open")
			return { ...state, notice: String(result), error: undefined };
		if (cmd.action === "evidence") return state;
		const done: Record<string, string> = {
			approve: "Approved",
			revise: "Sent back with your note",
			kill: "Killed",
			park: "Parked",
			resume: "Resumed",
			claim: "Review claimed; use ephyra release <trail> before deciding",
			land: "Landing requested",
			comment: "Comment posted",
		};
		return {
			...state,
			notice: done[cmd.action]
				? `${done[cmd.action]} · ${cmd.item.short}`
				: undefined,
		};
	} catch (error) {
		const message =
			error instanceof ApiError && error.status === 409
				? error.message
				: cmd.action === "open"
					? "Couldn't open the landing"
					: "Action failed or outcome unknown; refresh before retrying";
		return { ...before, error: message, notice: undefined };
	}
}
