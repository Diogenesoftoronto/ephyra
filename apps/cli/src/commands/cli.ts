import type { Trail } from "@ephyra/core";
import { Client } from "../client";
import { DOCS_TOPICS, docsTopic, docsUrl } from "../docs";
import { toAnsi } from "../inbox/paint";
import type { FileEntry } from "../inbox/reducer";
import { terminal } from "../inbox/run";
import { plain, trailView, trailsView, type Line } from "../inbox/view";
import { init } from "../init";
import { loadCredentials, login, logout } from "../login";
import { doctor, handoffBrief, repoFacts } from "./doctor";
import { COMMANDS, commandHelpView, commandNames, findCommand, helpView, suggest, usageError } from "./help";
import {
	activityView, agentsView, doctorView, policyView, questionsView, runEventsView, runView, runsView, setupView, usageView,
} from "./views";

export const CLI_VERSION = "0.0.0";

/** A usage mistake: the message already says how to call the command, so main.ts prints it as is. */
export class UsageError extends Error {}

/** Take `--name value` out of the arguments. */
function option(args: string[], ...names: string[]): string | undefined {
	for (const name of names) {
		const i = args.indexOf(name);
		if (i < 0) continue;
		const value = args[i + 1];
		args.splice(i, value === undefined ? 1 : 2);
		return value;
	}
	return undefined;
}
function flag(args: string[], ...names: string[]): boolean {
	let found = false;
	for (const name of names) {
		const i = args.indexOf(name);
		if (i >= 0) {
			args.splice(i, 1);
			found = true;
		}
	}
	return found;
}

/** Put text on the system clipboard with whatever this machine has. False when nothing worked. */
async function copy(text: string): Promise<boolean> {
	const tools = process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
	for (const tool of tools) {
		try {
			const proc = Bun.spawn(tool, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
			proc.stdin.write(text);
			await proc.stdin.end();
			if ((await proc.exited) === 0) return true;
		} catch {
			/* try the next one */
		}
	}
	return false;
}

function openInBrowser(url: string) {
	try {
		Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });
	} catch {
		/* printing the link is enough */
	}
}

export async function main(args: string[]) {
	args = [...args];
	const json = flag(args, "--json");
	const wantsHelp = flag(args, "--help", "-h");
	if (flag(args, "--version", "-v") && !args.length) return console.log(json ? JSON.stringify({ version: CLI_VERSION }) : `ephyra ${CLI_VERSION}`);
	const cols = process.stdout.columns || 100;
	// Human output is drawn by the same view as the inbox; --json keeps the raw API shape for scripts.
	const paint = (lines: Line[]) => console.log(process.stdout.isTTY && !process.env.NO_COLOR ? toAnsi(lines) : plain(lines));
	const emit = (value: unknown) => console.log(JSON.stringify(value, null, json ? 0 : 2));
	let cmd = args.shift();

	if (!cmd || cmd === "help" || wantsHelp) {
		const topic = cmd === "help" ? args[0] : wantsHelp ? cmd : undefined;
		if (!topic) return json ? emit(COMMANDS) : paint(helpView(cols));
		const found = findCommand(topic);
		if (!found) throw new UsageError(unknown(topic));
		return json ? emit(found) : paint(commandHelpView(found, Math.min(cols, 100)));
	}
	if (cmd === "version") return console.log(json ? JSON.stringify({ version: CLI_VERSION }) : `ephyra ${CLI_VERSION}`);
	const help = findCommand(cmd);
	if (!help) throw new UsageError(unknown(cmd));
	cmd = help.name;
	const usage = () => new UsageError(usageError(help));

	if (cmd === "init") {
		const remote = option(args, "--remote") ?? "origin";
		const value = await init(process.cwd(), remote, flag(args, "--force"));
		if (json) return console.log(JSON.stringify(value));
		console.log(`Created: ${value.join(", ") || "none (existing files were kept; --force replaces them)"}`);
		console.log("Next: edit ephyra/autonomy.md to describe your areas, then `ephyra doctor`.");
		return;
	}
	if (cmd === "docs") {
		const open = flag(args, "--open");
		const slug = docsTopic(args[0]);
		if (!slug) {
			const topics = Object.entries(DOCS_TOPICS).map(([name, about]) => `  ${name.padEnd(16)}${about}`).join("\n");
			throw new UsageError(`No documentation page for “${args[0]}”. Topics:\n${topics}`);
		}
		const url = docsUrl(slug);
		if (json) return emit({ topic: slug, url, markdown: slug === "index" ? `${url}/agent.md` : `${url}.md` });
		console.log(url);
		if (!args[0]) console.log(`\nTopics (ephyra docs <topic>):\n${Object.entries(DOCS_TOPICS).map(([name, about]) => `  ${name.padEnd(16)}${about}`).join("\n")}`);
		if (open) openInBrowser(url);
		return;
	}
	const io = { print: (line: string) => console.log(line), sleep: (ms: number) => Bun.sleep(ms), fetch, env: process.env, open: openInBrowser };
	if (cmd === "login") {
		const url = args[0] ?? process.env.EPHYRA_URL;
		if (!url) throw usage();
		await login(url, io);
		console.log("Next: `ephyra doctor` checks this repository; `ephyra inbox` shows what is waiting.");
		return;
	}
	if (cmd === "logout") return logout(io);

	// Signed-in session (from `ephyra login`) first; the service token is for automation.
	const creds = await loadCredentials();
	const url = process.env.EPHYRA_URL ?? creds?.url;
	let client: Client | null = null;
	let authProblem = "Not signed in. Run `ephyra login <server-url>`, then `ephyra doctor` if anything else is off.";
	if (process.env.EPHYRA_API_TOKEN && url) {
		if (process.env.EPHYRA_PRINCIPAL) client = new Client(url, process.env.EPHYRA_API_TOKEN, fetch, process.env.EPHYRA_PRINCIPAL);
		else authProblem = "EPHYRA_API_TOKEN needs EPHYRA_PRINCIPAL";
	} else if (creds && url === creds.url) client = new Client(creds.url, creds.token, fetch, "");

	if (cmd === "doctor" || cmd === "handoff") {
		const repo = repoFacts(process.cwd());
		const report = await doctor({ env: process.env, creds, client, ...(url ? { url } : {}), repo, fetch });
		if (cmd === "doctor") {
			if (json) emit(report.checks);
			else paint(doctorView(report.checks, Math.min(cols, 110)));
			if (report.checks.some((c) => c.status === "fail")) process.exitCode = 1;
			return;
		}
		const brief = handoffBrief({ ...(url ? { url } : {}), who: creds?.handle ?? report.principal, repo, report, env: process.env });
		if (json) return emit({ brief });
		const copied = flag(args, "--copy") && (await copy(brief));
		console.log(brief);
		console.error(copied ? "\nCopied to the clipboard. Paste it into your coding agent." : "\nPaste the text above into your coding agent (--copy puts it on the clipboard).");
		return;
	}

	if (!client) throw new Error(authProblem);
	const c = client;
	if (cmd === "whoami") {
		const res = await fetch(new URL("/auth/me", c.url), { headers: { Authorization: `Bearer ${c.token}` } });
		if (res.ok) return console.log(JSON.stringify(await res.json(), null, json ? 0 : 2));
		// A service token has no browser session; /v1/me still says who the API thinks it is.
		if (c.principal) return emit(await c.me());
		console.log("Not signed in (or the session expired). Run `ephyra login <server-url>`.");
		return;
	}
	if (cmd === "open") {
		const target = args[0] ? `${c.url}/app/#/inbox/${encodeURIComponent(await c.resolve(args[0]))}` : `${c.url}/app/`;
		if (json) return emit({ url: target });
		console.log(target);
		openInBrowser(target);
		return;
	}

	let result: unknown;
	if (cmd === "status") result = await c.health();
	else if (cmd === "quests") {
		result = await c.trails(option(args, "--state"));
		if (!json) return paint(trailsView(result as Trail[], cols));
	} else if (cmd === "inbox") {
		if (!json) return terminal(c);
		result = await c.inbox();
	} else if (cmd === "show") {
		if (!args[0]) throw usage();
		const detail = await c.show(args[0]);
		if (json) result = detail;
		else {
			const read = async (path: string): Promise<FileEntry> => {
				try {
					const text = await c.file(detail.trail.id, path);
					return text === null ? { status: "missing" } : { status: "ready", text };
				} catch {
					return { status: "error", message: "couldn't fetch it" };
				}
			};
			const [hypothesis, plan] = await Promise.all([read("hypothesis.md"), read("plan.md")]);
			return paint(trailView(detail.trail, detail.events, { hypothesis, plan }, Math.min(cols, 110)));
		}
	} else if (cmd === "file") {
		if (!args[0] || !args[1]) throw usage();
		const text = await c.file(await c.resolve(args[0]), args[1]);
		if (text === null) throw new Error(`The journal has no ${args[1]} for this quest yet.`);
		return console.log(json ? JSON.stringify({ path: args[1], content: text }) : text.replace(/\n$/, ""));
	} else if (cmd === "activity") {
		const limit = Number(option(args, "--limit")) || undefined;
		const items = await c.activity(limit);
		if (!json) return paint(activityView(items, cols));
		result = items;
	} else if (cmd === "runs") {
		const quest = option(args, "--quest", "--trail");
		const status = option(args, "--status");
		const limit = Number(option(args, "--limit")) || undefined;
		const runs = await c.runs({ ...(quest ? { trail: await c.resolve(quest) } : {}), ...(status ? { status } : {}), ...(limit ? { limit } : {}) });
		if (!json) return paint(runsView(runs, cols));
		result = runs;
	} else if (cmd === "run") {
		const follow = flag(args, "--follow", "-f");
		if (!args[0]) throw usage();
		let run = await c.run(args[0]);
		const events = await c.runEvents(run.id);
		// Page through what is already recorded before deciding whether there is anything to follow.
		let last = events.at(-1)?.seq;
		for (;;) {
			const more = last === undefined ? [] : await c.runEvents(run.id, last);
			if (!more.length) break;
			events.push(...more);
			last = more.at(-1)!.seq;
		}
		if (json && !follow) result = { run, events };
		else {
			if (json) for (const e of events) console.log(JSON.stringify(e));
			else paint(runView(run, events, Math.min(cols, 120)));
			while (follow && run.status === "running") {
				await Bun.sleep(2000);
				const more = await c.runEvents(run.id, last);
				if (more.length) {
					last = more.at(-1)!.seq;
					if (json) for (const e of more) console.log(JSON.stringify(e));
					else paint(runEventsView(more, Math.min(cols, 120)));
				} else run = await c.run(run.id);
			}
			if (follow && !json) console.log(`Run ${run.status}.`);
			return;
		}
	} else if (cmd === "usage") {
		const days = Number(option(args, "--days")) || undefined;
		const summary = await c.usage(days);
		if (!json) return paint(usageView(summary, cols));
		result = summary;
	} else if (cmd === "policy") {
		const [active, docs] = await Promise.all([c.policyActive(), c.policyDocs()]);
		if (!json) return paint(policyView(active, docs, cols));
		result = { active, documents: docs };
	} else if (cmd === "setup") {
		const run = await c.setup();
		if (!json) return paint(setupView(run, Math.min(cols, 110)));
		result = run;
	} else if (cmd === "ops") result = await c.ops();
	else if (cmd === "questions") {
		const questions = await c.questions();
		if (!json) return paint(questionsView(questions, Math.min(cols, 110)));
		result = questions;
	} else if (cmd === "answer") {
		const text = option(args, "-m", "--message");
		if (!args[0] || !text) throw usage();
		const matches = (await c.questions()).filter((q) => q.id.startsWith(args[0]!.toLowerCase()));
		if (matches.length !== 1) throw new Error(matches.length ? "That id matches more than one question; give more characters." : "No open question has that id. `ephyra questions` lists them.");
		result = await c.answer(matches[0]!, text);
		if (!json) return console.log("Answer recorded. The investigation checks it before using it.");
	} else if (cmd === "agents") {
		if (args[0] === "revoke") {
			if (!args[1]) throw usage();
			result = await c.revokeAgent(args[1]);
			if (!json) return console.log((result as { revoked: boolean }).revoked ? "Access revoked." : "Nothing to revoke: no active agent has that id.");
		} else {
			const agents = await c.agents();
			if (!json) return paint(agentsView(agents, cols));
			result = agents;
		}
	} else if (cmd === "decide") {
		const note = option(args, "-m", "--message");
		const [id, checkpoint, verdict] = args;
		if (!id || !["A", "B", "C"].includes(checkpoint ?? "") || !["approve", "revise", "reject"].includes(verdict ?? "")) throw usage();
		const trailId = await c.resolve(id);
		// Bind the decision to what is waiting now, so a quest that moved on is refused instead of approved unread.
		const waiting = (await c.inbox().catch(() => [])).find((i) => i.trailId === trailId && i.kind === "checkpoint" && i.checkpoint === checkpoint);
		result = await c.action(trailId, "decide", { checkpoint, verdict, ...(note ? { note } : {}), ...(waiting ? { bound: waiting.bound } : {}) });
		if (!json) return console.log(`${checkpoint} ${verdict === "approve" ? "approved" : verdict === "revise" ? "sent back" : "rejected"}.${checkpoint === "C" && verdict === "approve" ? " The quest lands next; `ephyra show` follows it." : ""}`);
	} else if (cmd === "spend") {
		const note = option(args, "-m", "--message");
		const [id, verdict] = args;
		if (!id || !["approve", "reject"].includes(verdict ?? "")) throw usage();
		result = await c.spend(await c.resolve(id), verdict!, note);
		if (!json) return console.log(verdict === "approve" ? "Spend approved." : "Spend declined; the quest continues without that study.");
	} else if (["comment", "claim", "release", "park", "resume", "kill", "land"].includes(cmd)) {
		const note = option(args, "-m", "--message");
		if (!args[0] || (["comment", "kill"].includes(cmd) && !note)) throw usage();
		result = await c.action(await c.resolve(args[0]), cmd, cmd === "comment" ? { text: note } : cmd === "kill" ? { reason: note } : {});
		const said: Record<string, string> = {
			comment: "Comment posted.", claim: "Review claimed. `ephyra release` it before you decide.", release: "Review released.",
			park: "Parked. `ephyra resume` continues it.", resume: "Resumed.", kill: "Killed.", land: "Landing requested. `ephyra show` follows it.",
		};
		if (!json) return console.log(said[cmd]);
	} else throw usage();
	emit(result);
}

function unknown(name: string): string {
	const close = suggest(name);
	return `Unknown command “${name}”.${close ? ` Did you mean \`ephyra ${close}\`?` : ""}\nRun \`ephyra help\` to see all ${commandNames().length} commands.`;
}
