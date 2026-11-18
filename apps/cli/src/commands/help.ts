// What the CLI can do, in one table. `ephyra help`, `ephyra help <command>`, the usage error and the
// "did you mean" hint and shell completions all read it. test/help.test.ts checks main() handles every entry.
import { AgentRun, Checkpoint, TrailState, Verdict } from "@ephyra/core";
import { DOCS_TOPICS, docsUrl } from "../docs";
import { row, type Line, type Seg, type Tone } from "../inbox/view";
import { wrap } from "../inbox/text";

export type CommandGroup = "Set up" | "See" | "Decide" | "Operate";
export type CommandOption = {
	/** Exact accepted spellings, including their dashes. */
	flags: readonly string[];
	description: string;
	/** A placeholder means this option consumes a value; omitted for boolean flags. */
	value?: string;
	values?: readonly string[];
	rootOnly?: boolean;
};
export type CommandArgument = {
	name: string;
	values?: readonly string[];
	/** Resolve changing catalogs from their source of truth, without network calls. */
	catalog?: "commands" | "docs";
};
export const GLOBAL_OPTIONS: readonly CommandOption[] = [
	{ flags: ["--json"], description: "Print machine-readable output" },
	{ flags: ["--help", "-h"], description: "Show help" },
	{ flags: ["--version", "-v"], description: "Show the CLI version", rootOnly: true },
];
export const COMPLETION_SHELLS = ["bash", "zsh", "fish", "powershell"] as const;

const MESSAGE_OPTION: CommandOption = {
	flags: ["--message", "-m"], description: "Message or reason to record", value: "text",
};

export type CommandHelp = {
	name: string;
	/** Other spellings main() accepts. */
	aliases?: string[];
	group: CommandGroup;
	usage: string;
	summary: string;
	/** The longer answer: when you'd reach for it and what to expect. */
	detail?: string;
	examples?: string[];
	/** The docs page that covers it. */
	docs?: keyof typeof DOCS_TOPICS;
	/** Works without being signed in. */
	offline?: boolean;
	options?: readonly CommandOption[];
	arguments?: readonly CommandArgument[];
};

export const COMMANDS: readonly CommandHelp[] = [
	{
		name: "login",
		group: "Set up",
		usage: "ephyra login <server-url>",
		arguments: [{ name: "server-url" }],
		offline: true,
		summary: "Sign in with Not Organic through your browser",
		detail:
			"Opens an approval page and shows a short code; approve the request showing the same code. The CLI keeps only an Ephyra session token, in a file readable " +
			"by you alone.",
		examples: ["ephyra login https://console.ephyra.quest"],
		docs: "cli",
	},
	{
		name: "logout",
		group: "Set up",
		usage: "ephyra logout",
		offline: true,
		summary: "End the session and remove the saved token",
		docs: "cli",
	},
	{
		name: "whoami",
		group: "Set up",
		usage: "ephyra whoami",
		summary: "Show who you are here and whether you can approve",
		docs: "cli",
	},
	{
		name: "doctor",
		group: "Set up",
		usage: "ephyra doctor",
		offline: true,
		summary:
			"Check the server, your sign-in, this repository and setup; say what to fix",
		detail:
			"Run this first when something does not work. Each line is a check that passed, a warning, or a failure with the next step. It reads; it never " +
			"changes anything.",
		docs: "troubleshooting",
	},
	{
		name: "init",
		group: "Set up",
		usage: "ephyra init [--remote origin] [--force]",
		options: [
			{ flags: ["--remote"], description: "Git remote to configure", value: "remote" },
			{ flags: ["--force"], description: "Replace existing policy templates" },
		],
		offline: true,
		summary:
			"Add shadow-mode policy templates and the refs/ephyra/* refspecs to this repository",
		detail:
			"Writes ephyra/autonomy.md, thresholds.yaml and models.yaml (existing files are kept unless --force) and configures the remote to fetch and push " +
			"refs/ephyra/*, where quest journals live.",
		docs: "quickstart",
	},
	{
		name: "setup",
		group: "Set up",
		usage: "ephyra setup [--interactive]",
		offline: true,
		options: [{ flags: ["--interactive"], description: "Start the guided setup wizard" }],
		summary: "Show recorded setup progress, or start the guided wizard with --interactive",
		detail:
			"Setup is a recorded run, not a switch. This prints each step, what Ephyra can observe (repository, checks, telemetry, deployment, knowledge, contact) " +
			"and the blockers with who has to act. --interactive starts a guided wizard in your terminal, including sign-in when needed.",
		docs: "quickstart",
	},
	{
		name: "handoff",
		group: "Set up",
		usage: "ephyra handoff [--copy]",
		options: [{ flags: ["--copy"], description: "Copy the brief to the clipboard" }],
		offline: true,
		summary:
			"Print a brief you can paste into your coding agent to set up or debug Ephyra here",
		detail:
			"Includes the server, this repository's remote and branch, what `doctor` found, and the links an agent needs. It contains no token. --copy puts it on " +
			"the clipboard.",
		docs: "agent-setup",
	},
	{
		name: "docs",
		group: "Set up",
		usage: "ephyra docs [topic] [--open]",
		arguments: [{ name: "topic", catalog: "docs" }],
		options: [{ flags: ["--open"], description: "Open the documentation in your browser" }],
		offline: true,
		summary: "Find the documentation page for a topic or a command",
		examples: ["ephyra docs", "ephyra docs policy", "ephyra docs stuck --open"],
	},
	{
		name: "complete",
		group: "Set up",
		usage: "ephyra complete <bash|zsh|fish|powershell>",
		arguments: [{ name: "shell", values: COMPLETION_SHELLS }],
		offline: true,
		summary: "Print the shell completion script",
		detail:
			"Load this script in your shell to complete commands and options. This command only prints; it does not edit your shell configuration. " +
			"Bash needs version 4 or later. The shell calls `ephyra complete -- ...` for suggestions; no sign-in or network is needed.",
		examples: [
			"source <(ephyra complete bash)",
			"source <(ephyra complete zsh)",
			"ephyra complete fish | source",
			"ephyra complete powershell | Out-String | Invoke-Expression",
		],
		docs: "cli",
	},

	{
		name: "quests",
		aliases: ["trails"],
		group: "See",
		usage: "ephyra quests [--state <state>]",
		options: [{ flags: ["--state"], description: "Filter by quest state", value: "state", values: TrailState.options }],
		summary: "List every quest and where it stands",
		examples: ["ephyra quests", "ephyra quests --state ready"],
		docs: "concepts",
	},
	{
		name: "show",
		group: "See",
		usage: "ephyra show <quest>",
		arguments: [{ name: "quest" }],
		summary: "One quest: its stage, hypothesis, plan, proof and activity",
		detail: "<quest> is a full id or the short one from the list (T-1a2b).",
		docs: "reviewing",
	},
	{
		name: "file",
		group: "See",
		usage: "ephyra file <quest> <path>",
		arguments: [
			{ name: "quest" },
			{ name: "path", values: [
				"hypothesis.md", "plan.md", "intent.md", "evidence/index.json", "proof/manifest.json",
				"decisions/latest-A.json", "decisions/latest-B.json", "decisions/latest-C.json",
			] },
		],
		summary: "Print a file from a quest's journal",
		detail:
			"Readable paths: hypothesis.md, plan.md, intent.md, evidence/index.json, proof/manifest.json, artefacts/<kind>/<name>, decisions/latest-A.json (or B, C).",
		examples: ["ephyra file T-1a2b proof/manifest.json"],
		docs: "journal",
	},
	{
		name: "inbox",
		group: "See",
		usage: "ephyra inbox",
		summary:
			"Open the keyboard inbox: what is waiting on a person, and what it asks you to judge",
		detail:
			"Press ? inside for the keys. With --json it prints the waiting items instead.",
		docs: "terminal",
	},
	{
		name: "activity",
		group: "See",
		usage: "ephyra activity [--limit n]",
		options: [{ flags: ["--limit"], description: "Maximum activity items", value: "n" }],
		summary: "What the agents are doing now and did recently",
		docs: "console",
	},
	{
		name: "runs",
		group: "See",
		usage:
			"ephyra runs [--quest <quest>] [--status running|done|failed|unavailable]",
		options: [
			{ flags: ["--quest", "--trail"], description: "Filter by quest", value: "quest" },
			{ flags: ["--status"], description: "Filter by run status", value: "status", values: AgentRun.shape.status.options },
			{ flags: ["--limit"], description: "Maximum runs", value: "n" },
		],
		summary: "List agent runs: which step, which engine, how it ended",
		docs: "console",
	},
	{
		name: "run",
		group: "See",
		usage: "ephyra run <run-id> [--follow]",
		arguments: [{ name: "run-id" }],
		options: [{ flags: ["--follow", "-f"], description: "Follow the transcript until the run ends" }],
		summary:
			"Read one run's transcript: messages, tool calls and policy decisions",
		detail: "--follow keeps reading until the run ends.",
		docs: "console",
	},
	{
		name: "usage",
		group: "See",
		usage: "ephyra usage [--days n]",
		options: [{ flags: ["--days"], description: "Days of usage to include", value: "n" }],
		summary: "Tokens, known spend, unknown costs and per-quest budgets",
		detail:
			"Unknown costs are counted separately and never folded into the total as zero, so the spend shown is a lower bound when any are present.",
		docs: "budgets",
	},

	{
		name: "decide",
		group: "Decide",
		usage: "ephyra decide <quest> <A|B|C> <approve|revise|reject> [-m note]",
		arguments: [
			{ name: "quest" }, { name: "checkpoint", values: Checkpoint.options }, { name: "verdict", values: Verdict.options },
		],
		options: [MESSAGE_OPTION],
		summary: "Answer a checkpoint",
		detail:
			"The decision is bound to the revision that is waiting in your inbox. If the quest moved on, it is refused as stale rather than applied to something you " +
			"did not read. Approving C lands the quest.",
		examples: [
			"ephyra decide T-1a2b A approve",
			'ephyra decide T-1a2b C revise -m "the test only covers CAD"',
		],
		docs: "reviewing",
	},
	{
		name: "spend",
		group: "Decide",
		usage: "ephyra spend <quest> <approve|reject> [-m note]",
		arguments: [{ name: "quest" }, { name: "verdict", values: ["approve", "reject"] }],
		options: [MESSAGE_OPTION],
		summary: "Answer a request to spend on a real-respondent study",
		docs: "budgets",
	},
	{
		name: "comment",
		group: "Decide",
		usage: "ephyra comment <quest> -m <text>",
		arguments: [{ name: "quest" }],
		options: [MESSAGE_OPTION],
		summary: "Say something on the quest; the agent and reviewers see it",
		docs: "reviewing",
	},
	{
		name: "claim",
		group: "Decide",
		usage: "ephyra claim <quest>",
		arguments: [{ name: "quest" }],
		summary: "Take a checkpoint review so nobody else decides it under you",
		docs: "reviewing",
	},
	{
		name: "release",
		group: "Decide",
		usage: "ephyra release <quest>",
		arguments: [{ name: "quest" }],
		summary: "Give a claimed review back; do this before deciding",
		docs: "reviewing",
	},
	{
		name: "park",
		group: "Decide",
		usage: "ephyra park <quest>",
		arguments: [{ name: "quest" }],
		summary: "Pause a quest where it is",
		docs: "reviewing",
	},
	{
		name: "resume",
		group: "Decide",
		usage: "ephyra resume <quest>",
		arguments: [{ name: "quest" }],
		summary: "Continue a parked quest from the state it was in",
		docs: "reviewing",
	},
	{
		name: "kill",
		group: "Decide",
		usage: "ephyra kill <quest> -m <reason>",
		arguments: [{ name: "quest" }],
		options: [MESSAGE_OPTION],
		summary: "Stop a quest for good, with a reason",
		docs: "budgets",
	},
	{
		name: "land",
		group: "Decide",
		usage: "ephyra land <quest>",
		arguments: [{ name: "quest" }],
		summary: "Land a ready quest whose proof is already approved",
		docs: "landing-watch",
	},
	{
		name: "questions",
		group: "Decide",
		usage: "ephyra questions",
		summary: "Questions an investigation is waiting on you to answer",
		docs: "reviewing",
	},
	{
		name: "answer",
		group: "Decide",
		usage: "ephyra answer <question-id> -m <text>",
		arguments: [{ name: "question-id" }],
		options: [MESSAGE_OPTION],
		summary: "Answer one of those questions with a fact",
		detail:
			"<question-id> can be the first characters shown by `ephyra questions`.",
		docs: "reviewing",
	},

	{
		name: "status",
		group: "Operate",
		usage: "ephyra status",
		summary: "Server health, store mode and release revision",
		docs: "self-hosting",
	},
	{
		name: "policy",
		group: "Operate",
		usage: "ephyra policy [show|edit|set|add|rm|raw|diff|publish|activate|discard] [area]",
		arguments: [{ name: "action", values: ["show", "edit", "set", "add", "rm", "raw", "diff", "publish", "activate", "discard"] }, { name: "area" }],
		options: [
			{ flags: ["--level"], description: "How far Ephyra may go alone in the area", value: "level", values: ["watch", "research", "propose", "patch", "auto"] },
			{ flags: ["--risk"], description: "How risky the area is", value: "risk", values: ["low", "medium", "high", "critical"] },
			{ flags: ["--paths"], description: "Comma separated globs the area covers", value: "globs" },
			{ flags: ["--about"], description: "What this part of the application is, in a sentence", value: "text" },
			{ flags: ["--user-facing"], description: "People use this area directly" },
			{ flags: ["--internal"], description: "People do not use this area directly" },
			{ flags: ["--raw"], description: "With edit: open the document itself in $EDITOR" },
			{ flags: ["--draft"], description: "With raw: print the open draft instead of the policy in effect" },
		],
		summary:
			"See and change what Ephyra may do, area by area, or edit the raw document",
		detail:
			"With no action it prints the policy in effect as a map: one line per area with its risk, a five-step autonomy level and its paths, "
			+ "then the active receipt and each document's warnings. `edit` opens the same map as a board you drive with keys; "
			+ "`edit --raw` opens autonomy.md in $EDITOR. `set`, `add` and `rm` change one area from a script. "
			+ "Every change is saved to a draft: `diff` shows it, `publish` publishes it, `activate` puts it into effect and `discard` drops it. "
			+ "Publishing and activating need a signed-in approver.",
		examples: [
			"ephyra policy",
			"ephyra policy edit",
			"ephyra policy set checkout --level propose",
			"ephyra policy add docs --paths 'docs/**' --risk low --level auto",
			"ephyra policy edit --raw",
			"ephyra policy raw > autonomy.md",
		],
		docs: "policy",
	},
	{
		name: "agents",
		group: "Operate",
		usage: "ephyra agents [revoke <id>]",
		arguments: [{ name: "action", values: ["revoke"] }, { name: "id" }],
		summary: "Coding agents you approved for setup, and how to revoke one",
		docs: "agent-setup",
	},
	{
		name: "ops",
		group: "Operate",
		usage: "ephyra ops",
		summary: "Worker ownership, dead jobs and effects that need reconciliation",
		docs: "troubleshooting",
	},
	{
		name: "open",
		group: "Operate",
		usage: "ephyra open [quest]",
		arguments: [{ name: "quest" }],
		summary: "Open the web console, at a quest if you name one",
		docs: "console",
	},
	{
		name: "help",
		group: "Operate",
		usage: "ephyra help [command]",
		arguments: [{ name: "command", catalog: "commands" }],
		offline: true,
		summary: "Show all commands or help for one command",
	},
	{
		name: "version",
		group: "Operate",
		usage: "ephyra version",
		offline: true,
		summary: "Show the CLI version",
	},
];

const GROUPS: CommandGroup[] = ["Set up", "See", "Decide", "Operate"];
export const commandNames = (): string[] =>
	COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
export const findCommand = (name: string): CommandHelp | undefined =>
	COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));

const g = (text: string, tone: Tone = "fg", bold = false): Seg =>
	bold ? { text, tone, bold } : { text, tone };

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
	const d = Array.from({ length: a.length + 1 }, (_, i) => [
		i,
		...Array<number>(b.length).fill(0),
	]);
	for (let j = 1; j <= b.length; j++) d[0]![j] = j;
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++)
			d[i]![j] = Math.min(
				d[i - 1]![j]! + 1,
				d[i]![j - 1]! + 1,
				d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
	return d[a.length]![b.length]!;
}

/** The closest command to a mistyped one, if it is close enough to be a typo. */
export function suggest(name: string): string | undefined {
	const scored = commandNames()
		.map((c) => [c, distance(name.toLowerCase(), c)] as const)
		.sort((a, b) => a[1] - b[1]);
	const best = scored[0];
	return best && best[1] <= Math.max(1, Math.floor(name.length / 3))
		? best[0]
		: undefined;
}

/** `ephyra help`: every command by what you are trying to do, then where to go next. */
export function helpView(
	w = 80,
	env: Record<string, string | undefined> = process.env,
): Line[] {
	w = Math.max(40, Math.floor(w));
	const pad = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
	const out: Line[] = [
		[
			g("ephyra", "amber", true),
			g(
				" · production signals become quests you can review, land and watch",
				"muted",
			),
		],
		[],
		[
			g("usage  ", "muted"),
			g("ephyra <command> [arguments] [--json]", "strong"),
		],
	];
	for (const group of GROUPS) {
		out.push([], [g(group.toLowerCase(), "muted")]);
		for (const c of COMMANDS.filter((x) => x.group === group)) {
			const lines = wrap(c.summary, Math.max(20, w - pad - 2));
			lines.forEach((text, i) =>
				out.push([
					g("  "),
					g(i ? " ".repeat(pad) : c.name.padEnd(pad), "key", !i),
					g(text),
				]),
			);
		}
	}
	out.push(
		[],
		[
			g("first time?  ", "muted"),
			g("ephyra setup --interactive", "strong"),
		],
		[g("one command  ", "muted"), g("ephyra help <command>", "strong")],
		[
			g("for scripts  ", "muted"),
			g("--json", "strong"),
			g(" prints the raw API shape; NO_COLOR turns colour off", "muted"),
		],
		[g("the docs     ", "muted"), g(docsUrl("index", env), "strong")],
	);
	return out.map((l) => row(l, w));
}

/** `ephyra help <command>`. */
export function commandHelpView(
	c: CommandHelp,
	w = 80,
	env: Record<string, string | undefined> = process.env,
): Line[] {
	w = Math.max(40, Math.floor(w));
	const out: Line[] = [
		[g(c.usage, "strong", true)],
		[],
		...wrap(c.summary + ".", w).map((t) => [g(t)]),
	];
	if (c.detail) out.push([], ...wrap(c.detail, w).map((t) => [g(t, "muted")]));
	if (c.aliases?.length)
		out.push(
			[],
			[
				g("also      ", "muted"),
				g(c.aliases.map((a) => `ephyra ${a}`).join(", ")),
			],
		);
	if (c.examples?.length)
		out.push(
			[],
			[g("examples", "muted")],
			...c.examples.map((e) => [g("  "), g(e, "strong")]),
		);
	if (!c.offline)
		out.push(
			[],
			[
				g("needs     ", "muted"),
				g(
					"a signed-in session (ephyra login) or EPHYRA_URL, EPHYRA_API_TOKEN and EPHYRA_PRINCIPAL",
				),
			],
		);
	if (c.docs)
		out.push([g("read more ", "muted"), g(docsUrl(c.docs, env), "strong")]);
	return out.map((l) => row(l, w));
}

/** One line for a usage error: the right shape, and how to see more. */
export const usageError = (c: CommandHelp): string =>
	`Usage: ${c.usage}\nRun \`ephyra help ${c.name}\` for details.`;
