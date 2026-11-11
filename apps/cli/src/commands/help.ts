// What the CLI can do, in one table. `ephyra help`, `ephyra help <command>`, the usage error and the
// "did you mean" hint all read it, and test/help.test.ts checks every entry is handled by main().
import { DOCS_TOPICS, docsUrl } from "../docs";
import { row, type Line, type Seg, type Tone } from "../inbox/view";
import { wrap } from "../inbox/text";

export type CommandGroup = "Set up" | "See" | "Decide" | "Operate";
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
};

export const COMMANDS: readonly CommandHelp[] = [
	{
		name: "login", group: "Set up", usage: "ephyra login <server-url>", offline: true,
		summary: "Sign in with Not Organic through your browser",
		detail: "Opens an approval page and shows a short code; approve the request showing the same code. The CLI keeps only an Ephyra session token, in a file readable by you alone.",
		examples: ["ephyra login https://console.ephyra.quest"], docs: "cli",
	},
	{ name: "logout", group: "Set up", usage: "ephyra logout", offline: true, summary: "End the session and remove the saved token", docs: "cli" },
	{ name: "whoami", group: "Set up", usage: "ephyra whoami", summary: "Show who you are here and whether you can approve", docs: "cli" },
	{
		name: "doctor", group: "Set up", usage: "ephyra doctor", offline: true,
		summary: "Check the server, your sign-in, this repository and setup; say what to fix",
		detail: "Run this first when something does not work. Each line is a check that passed, a warning, or a failure with the next step. It reads; it never changes anything.",
		docs: "troubleshooting",
	},
	{
		name: "init", group: "Set up", usage: "ephyra init [--remote origin] [--force]", offline: true,
		summary: "Add shadow-mode policy templates and the refs/ephyra/* refspecs to this repository",
		detail: "Writes ephyra/autonomy.md, thresholds.yaml and models.yaml (existing files are kept unless --force) and configures the remote to fetch and push refs/ephyra/*, where quest journals live.",
		docs: "quickstart",
	},
	{
		name: "setup", group: "Set up", usage: "ephyra setup",
		summary: "Show the recorded setup: steps, coverage and what is blocking the loop",
		detail: "Setup is a recorded run, not a switch. This prints each step, what Ephyra can observe (repository, checks, telemetry, deployment, knowledge, contact) and the blockers with who has to act.",
		docs: "quickstart",
	},
	{
		name: "handoff", group: "Set up", usage: "ephyra handoff [--copy]", offline: true,
		summary: "Print a brief you can paste into your coding agent to set up or debug Ephyra here",
		detail: "Includes the server, this repository's remote and branch, what `doctor` found, and the links an agent needs. It contains no token. --copy puts it on the clipboard.",
		docs: "agent-setup",
	},
	{
		name: "docs", group: "Set up", usage: "ephyra docs [topic] [--open]", offline: true,
		summary: "Find the documentation page for a topic or a command",
		examples: ["ephyra docs", "ephyra docs policy", "ephyra docs stuck --open"],
	},

	{
		name: "quests", aliases: ["trails"], group: "See", usage: "ephyra quests [--state <state>]",
		summary: "List every quest and where it stands",
		examples: ["ephyra quests", "ephyra quests --state ready"], docs: "concepts",
	},
	{
		name: "show", group: "See", usage: "ephyra show <quest>",
		summary: "One quest: its stage, hypothesis, plan, proof and activity",
		detail: "<quest> is a full id or the short one from the list (T-1a2b).", docs: "reviewing",
	},
	{
		name: "file", group: "See", usage: "ephyra file <quest> <path>",
		summary: "Print a file from a quest's journal",
		detail: "Readable paths: hypothesis.md, plan.md, intent.md, evidence/index.json, proof/manifest.json, artefacts/<kind>/<name>, decisions/latest-A.json (or B, C).",
		examples: ["ephyra file T-1a2b proof/manifest.json"], docs: "journal",
	},
	{
		name: "inbox", group: "See", usage: "ephyra inbox",
		summary: "Open the keyboard inbox: what is waiting on a person, and what it asks you to judge",
		detail: "Press ? inside for the keys. With --json it prints the waiting items instead.", docs: "terminal",
	},
	{ name: "activity", group: "See", usage: "ephyra activity [--limit n]", summary: "What the agents are doing now and did recently", docs: "console" },
	{
		name: "runs", group: "See", usage: "ephyra runs [--quest <quest>] [--status running|done|failed|unavailable]",
		summary: "List agent runs: which step, which engine, how it ended", docs: "console",
	},
	{
		name: "run", group: "See", usage: "ephyra run <run-id> [--follow]",
		summary: "Read one run's transcript: messages, tool calls and policy decisions",
		detail: "--follow keeps reading until the run ends.", docs: "console",
	},
	{
		name: "usage", group: "See", usage: "ephyra usage [--days n]",
		summary: "Tokens, known spend, unknown costs and per-quest budgets",
		detail: "Unknown costs are counted separately and never folded into the total as zero, so the spend shown is a lower bound when any are present.",
		docs: "budgets",
	},

	{
		name: "decide", group: "Decide", usage: "ephyra decide <quest> <A|B|C> <approve|revise|reject> [-m note]",
		summary: "Answer a checkpoint",
		detail: "The decision is bound to the revision that is waiting in your inbox. If the quest moved on, it is refused as stale rather than applied to something you did not read. Approving C lands the quest.",
		examples: ["ephyra decide T-1a2b A approve", 'ephyra decide T-1a2b C revise -m "the test only covers CAD"'], docs: "reviewing",
	},
	{ name: "spend", group: "Decide", usage: "ephyra spend <quest> <approve|reject> [-m note]", summary: "Answer a request to spend on a real-respondent study", docs: "budgets" },
	{ name: "comment", group: "Decide", usage: "ephyra comment <quest> -m <text>", summary: "Say something on the quest; the agent and reviewers see it", docs: "reviewing" },
	{ name: "claim", group: "Decide", usage: "ephyra claim <quest>", summary: "Take a checkpoint review so nobody else decides it under you", docs: "reviewing" },
	{ name: "release", group: "Decide", usage: "ephyra release <quest>", summary: "Give a claimed review back; do this before deciding", docs: "reviewing" },
	{ name: "park", group: "Decide", usage: "ephyra park <quest>", summary: "Pause a quest where it is", docs: "reviewing" },
	{ name: "resume", group: "Decide", usage: "ephyra resume <quest>", summary: "Continue a parked quest from the state it was in", docs: "reviewing" },
	{ name: "kill", group: "Decide", usage: "ephyra kill <quest> -m <reason>", summary: "Stop a quest for good, with a reason", docs: "budgets" },
	{ name: "land", group: "Decide", usage: "ephyra land <quest>", summary: "Land a ready quest whose proof is already approved", docs: "landing-watch" },
	{ name: "questions", group: "Decide", usage: "ephyra questions", summary: "Questions an investigation is waiting on you to answer", docs: "reviewing" },
	{ name: "answer", group: "Decide", usage: "ephyra answer <question-id> -m <text>", summary: "Answer one of those questions with a fact", detail: "<question-id> can be the first characters shown by `ephyra questions`.", docs: "reviewing" },

	{ name: "status", group: "Operate", usage: "ephyra status", summary: "Server health, store mode and release revision", docs: "self-hosting" },
	{ name: "policy", group: "Operate", usage: "ephyra policy", summary: "The policy in effect: the active receipt and each document's warnings", docs: "policy" },
	{ name: "agents", group: "Operate", usage: "ephyra agents [revoke <id>]", summary: "Coding agents you approved for setup, and how to revoke one", docs: "agent-setup" },
	{ name: "ops", group: "Operate", usage: "ephyra ops", summary: "Worker ownership, dead jobs and effects that need reconciliation", docs: "troubleshooting" },
	{ name: "open", group: "Operate", usage: "ephyra open [quest]", summary: "Open the web console, at a quest if you name one", docs: "console" },
];

const GROUPS: CommandGroup[] = ["Set up", "See", "Decide", "Operate"];
export const commandNames = (): string[] => COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
export const findCommand = (name: string): CommandHelp | undefined =>
	COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));

const g = (text: string, tone: Tone = "fg", bold = false): Seg => (bold ? { text, tone, bold } : { text, tone });

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
	const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) d[0]![j] = j;
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++)
			d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
	return d[a.length]![b.length]!;
}

/** The closest command to a mistyped one, if it is close enough to be a typo. */
export function suggest(name: string): string | undefined {
	const scored = commandNames().map((c) => [c, distance(name.toLowerCase(), c)] as const).sort((a, b) => a[1] - b[1]);
	const best = scored[0];
	return best && best[1] <= Math.max(1, Math.floor(name.length / 3)) ? best[0] : undefined;
}

/** `ephyra help`: every command by what you are trying to do, then where to go next. */
export function helpView(w = 80, env: Record<string, string | undefined> = process.env): Line[] {
	w = Math.max(40, Math.floor(w));
	const pad = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
	const out: Line[] = [
		[g("ephyra", "amber", true), g(" · production signals become quests you can review, land and watch", "muted")],
		[],
		[g("usage  ", "muted"), g("ephyra <command> [arguments] [--json]", "strong")],
	];
	for (const group of GROUPS) {
		out.push([], [g(group.toLowerCase(), "muted")]);
		for (const c of COMMANDS.filter((x) => x.group === group)) {
			const lines = wrap(c.summary, Math.max(20, w - pad - 2));
			lines.forEach((text, i) => out.push([g("  "), g(i ? " ".repeat(pad) : c.name.padEnd(pad), "key", !i), g(text)]));
		}
	}
	out.push(
		[],
		[g("first time?  ", "muted"), g("ephyra login <server-url>", "strong"), g(", then ", "muted"), g("ephyra doctor", "strong")],
		[g("one command  ", "muted"), g("ephyra help <command>", "strong")],
		[g("for scripts  ", "muted"), g("--json", "strong"), g(" prints the raw API shape; NO_COLOR turns colour off", "muted")],
		[g("the docs     ", "muted"), g(docsUrl("index", env), "strong")],
	);
	return out.map((l) => row(l, w));
}

/** `ephyra help <command>`. */
export function commandHelpView(c: CommandHelp, w = 80, env: Record<string, string | undefined> = process.env): Line[] {
	w = Math.max(40, Math.floor(w));
	const out: Line[] = [[g(c.usage, "strong", true)], [], ...wrap(c.summary + ".", w).map((t) => [g(t)])];
	if (c.detail) out.push([], ...wrap(c.detail, w).map((t) => [g(t, "muted")]));
	if (c.aliases?.length) out.push([], [g("also      ", "muted"), g(c.aliases.map((a) => `ephyra ${a}`).join(", "))]);
	if (c.examples?.length) out.push([], [g("examples", "muted")], ...c.examples.map((e) => [g("  "), g(e, "strong")]));
	if (!c.offline) out.push([], [g("needs     ", "muted"), g("a signed-in session (ephyra login) or EPHYRA_URL, EPHYRA_API_TOKEN and EPHYRA_PRINCIPAL")]);
	if (c.docs) out.push([g("read more ", "muted"), g(docsUrl(c.docs, env), "strong")]);
	return out.map((l) => row(l, w));
}

/** One line for a usage error: the right shape, and how to see more. */
export const usageError = (c: CommandHelp): string => `Usage: ${c.usage}\nRun \`ephyra help ${c.name}\` for details.`;
