import { ApiError, Client } from "../client";
import { inboxReducer, type InboxState, type Command } from "./reducer";
import { renderInbox } from "./render-ansi";
import { emitKeypressEvents } from "node:readline";

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
		return "Opened landing";
	}
	if (action === "evidence")
		return item.evidenceIndex ?? "Evidence index unavailable";
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
	const view = new TextRenderable(renderer, {
		content: renderInbox(state),
		width: "100%",
		height: "100%",
	});
	renderer.root.add(view);
	const draw = () => {
		view.content = renderInbox(state, renderer.width, renderer.height);
	};
	let busy = false;
	const refresh = async () => {
		if (busy || state.modal) return;
		try {
			state = { ...state, items: await client.inbox(), error: undefined };
			state.selected = Math.max(
				0,
				Math.min(state.selected, state.items.length - 1),
			);
		} catch {
			state = { ...state, error: "Refresh failed" };
		}
		draw();
	};
	const timer = setInterval(refresh, 30000);
	renderer.keyInput.on("keypress", async (key) => {
		if (busy) return;
		if (key.name === "q" && !state.modal) {
			clearInterval(timer);
			renderer.destroy();
			return;
		}
		const result = inboxReducer(
			state,
			key.name === "return" || key.name === "enter"
				? "return"
				: key.name === "escape" || key.name === "backspace"
					? key.name
					: key.sequence,
		);
		state = result.state;
		draw();
		if (!result.command || busy) return;
		busy = true;
		state = await runCommand(client, state, result.command, (next) => {
			state = next;
			draw();
		});
		busy = false;
		draw();
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
			"\x1b[2J\x1b[H" +
				renderInbox(
					state,
					process.stdout.columns || 80,
					process.stdout.rows || 24,
				),
		);
	};
	const refresh = async () => {
		if (busy || state.modal) return;
		try {
			const items = await client.inbox();
			state = {
				...state,
				items,
				selected: Math.max(0, Math.min(state.selected, items.length - 1)),
				error: undefined,
			};
		} catch {
			state = { ...state, error: "Refresh failed" };
		}
		draw();
	};
	emitKeypressEvents(process.stdin);
	if (!process.stdin.isTTY) throw new Error("Inbox requires a terminal");
	process.stdin.setRawMode(true);
	process.stdin.resume();
	draw();
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
					process.stdin.setRawMode(false);
					process.stdin.pause();
					resolve();
					return;
				}
				if (busy) return;
				const input = ["return", "escape", "backspace"].includes(key.name)
					? key.name
					: text;
				const result = inboxReducer(state, input);
				state = result.state;
				draw();
				if (!result.command) return;
				busy = true;
				state = await runCommand(client, state, result.command, (next) => {
					state = next;
					draw();
				});
				busy = false;
				draw();
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
		};
		update(state);
	}
	try {
		const result = await execute(client, cmd);
		if (cmd.action === "open" || cmd.action === "evidence")
			return { ...state, error: String(result) };
		return state;
	} catch (error) {
		const message =
			error instanceof ApiError && error.status === 409
				? error.message
				: "Action failed or outcome unknown; refresh before retrying";
		return { ...before, error: message };
	}
}
