import { Client } from "../client";
import { terminal } from "../inbox/run";
import { init } from "../init";

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
	if (
		!process.env.EPHYRA_URL ||
		!process.env.EPHYRA_API_TOKEN ||
		!process.env.EPHYRA_PRINCIPAL
	)
		throw new Error("Set EPHYRA_URL, EPHYRA_API_TOKEN and EPHYRA_PRINCIPAL");
	const client = new Client(
		process.env.EPHYRA_URL,
		process.env.EPHYRA_API_TOKEN,
		fetch,
		process.env.EPHYRA_PRINCIPAL ?? "",
	);
	let result: unknown;
	if (cmd === "status") result = await client.health();
	else if (cmd === "trails") {
		const i = args.indexOf("--state");
		result = await client.trails(i < 0 ? undefined : args[i + 1]);
	} else if (cmd === "inbox") {
		if (!json) return terminal(client);
		result = await client.inbox();
	} else if (cmd === "show" && args[0]) result = await client.show(args[0]);
	else if (
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
			"Usage: ephyra init|status|trails|show|decide|comment|claim|release|park|resume|kill|land|inbox",
		);
	console.log(JSON.stringify(result, null, json ? 0 : 2));
}
