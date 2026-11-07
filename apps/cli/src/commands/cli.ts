import { Client } from "../client";
import { loadCredentials, login, logout } from "../login";
import { terminal } from "../inbox/run";
import { init } from "../init";
import type { Trail } from "@ephyra/core";
import type { FileEntry } from "../inbox/reducer";
import { toAnsi } from "../inbox/paint";
import { plain, trailView, trailsView, type Line } from "../inbox/view";

export async function main(args: string[]) {
	const json = args.includes("--json");
	args = args.filter((a) => a !== "--json");
	const cmd = args.shift();
	if (cmd === "init") {
		const remoteIndex = args.indexOf("--remote");
		const remote = remoteIndex < 0 ? "origin" : args[remoteIndex + 1];
		const value = await init(process.cwd(), remote, args.includes("--force"));
		console.log(
			json ? JSON.stringify(value) : `Created: ${value.join(", ") || "none"}`,
		);
		return;
	}
	const io = {
		print: (line: string) => console.log(line),
		sleep: (ms: number) => Bun.sleep(ms),
		fetch,
		env: process.env,
		open: (url: string) => {
			try {
				Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], {
					stdout: "ignore",
					stderr: "ignore",
				});
			} catch {
				/* printing the link is enough */
			}
		},
	};
	if (cmd === "login") {
		const url = args[0] ?? process.env.EPHYRA_URL;
		if (!url)
			throw new Error("Usage: ephyra login <server-url> (or set EPHYRA_URL)");
		await login(url, io);
		return;
	}
	if (cmd === "logout") return logout(io);
	// Signed-in session (from `ephyra login`) first; the service token is for automation.
	const creds = await loadCredentials();
	const url = process.env.EPHYRA_URL ?? creds?.url;
	let client: Client;
	if (process.env.EPHYRA_API_TOKEN && url) {
		if (!process.env.EPHYRA_PRINCIPAL)
			throw new Error("EPHYRA_API_TOKEN needs EPHYRA_PRINCIPAL");
		client = new Client(
			url,
			process.env.EPHYRA_API_TOKEN,
			fetch,
			process.env.EPHYRA_PRINCIPAL,
		);
	} else if (creds && url === creds.url) {
		client = new Client(creds.url, creds.token, fetch, "");
	} else {
		throw new Error("Not signed in. Run `ephyra login <server-url>`.");
	}
	if (cmd === "whoami") {
		const res = await fetch(new URL("/auth/me", client.url), {
			headers: { Authorization: `Bearer ${client.token}` },
		});
		console.log(
			res.ok
				? JSON.stringify(await res.json(), null, json ? 0 : 2)
				: "Not signed in (or the session expired).",
		);
		return;
	}
	let result: unknown;
	// Human output is drawn by the same view as the inbox; --json keeps the raw API shape for scripts.
	const paint = (lines: Line[]) =>
		console.log(
			process.stdout.isTTY && !process.env.NO_COLOR
				? toAnsi(lines)
				: plain(lines),
		);
	const cols = process.stdout.columns || 100;
	if (cmd === "status") result = await client.health();
	else if (cmd === "trails") {
		const i = args.indexOf("--state");
		result = await client.trails(i < 0 ? undefined : args[i + 1]);
		if (!json) return paint(trailsView(result as Trail[], cols));
	} else if (cmd === "inbox") {
		if (!json) return terminal(client);
		result = await client.inbox();
	} else if (cmd === "show" && args[0]) {
		const detail = await client.show(args[0]);
		if (json) result = detail;
		else {
			const read = async (path: string): Promise<FileEntry> => {
				try {
					const text = await client.file(detail.trail.id, path);
					return text === null
						? { status: "missing" }
						: { status: "ready", text };
				} catch {
					return { status: "error", message: "couldn't fetch it" };
				}
			};
			const [hypothesis, plan] = await Promise.all([
				read("hypothesis.md"),
				read("plan.md"),
			]);
			return paint(
				trailView(
					detail.trail,
					detail.events,
					{ hypothesis, plan },
					Math.min(cols, 110),
				),
			);
		}
	} else if (
		cmd === "decide" &&
		args[0] &&
		["A", "B", "C"].includes(args[1] ?? "") &&
		["approve", "revise", "reject"].includes(args[2] ?? "")
	) {
		const i = args.indexOf("-m");
		result = await client.action(args[0], "decide", {
			checkpoint: args[1],
			verdict: args[2],
			...(i >= 0 ? { note: args[i + 1] } : {}),
		});
	} else if (
		cmd &&
		["comment", "claim", "release", "park", "resume", "kill", "land"].includes(
			cmd,
		) &&
		args[0]
	) {
		const i = args.indexOf("-m");
		if (["comment", "kill"].includes(cmd) && (i < 0 || !args[i + 1]))
			throw new Error(`${cmd} requires -m text`);
		result = await client.action(
			args[0],
			cmd,
			cmd === "comment"
				? { text: args[i + 1] }
				: cmd === "kill"
					? { reason: args[i + 1] }
					: {},
		);
	} else
		throw new Error(
			"Usage: ephyra login|logout|whoami|init|status|trails|show|decide|comment|claim|release|park|resume|kill|land|inbox",
		);
	console.log(JSON.stringify(result, null, json ? 0 : 2));
}
