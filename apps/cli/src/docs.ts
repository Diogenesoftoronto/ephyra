// Where the documentation lives, and which page answers which question. The CLI, the inbox and `ephyra handoff`
// all link through here, so a self-hosted deployment can point them at its own copy with EPHYRA_DOCS_URL.

/** Works with or without a dedicated docs host: the public site redirects /docs/<page> there when one is configured. */
export const DEFAULT_DOCS_URL = "https://ephyra.quest/docs";

export const docsBase = (
	env: Record<string, string | undefined> = process.env,
): string => (env.EPHYRA_DOCS_URL || DEFAULT_DOCS_URL).replace(/\/+$/, "");

/** Every published page, by slug. `apps/web/test/docs.test.ts` checks this list against the pages that exist. */
export const DOCS_TOPICS: Record<string, string> = {
	quickstart: "Connect your first repository",
	"agent-setup": "Hand the setup to your coding agent",
	concepts: "Quests, checkpoints and proof",
	console: "The web console, screen by screen",
	cli: "Every command",
	terminal: "The terminal inbox and its keys",
	reviewing: "How to judge a checkpoint",
	connections: "Repository, models, telemetry, knowledge",
	policy: "What Ephyra may do, by area",
	proof: "What must exist before a repair lands",
	"study-evidence": "Importing persona and respondent studies",
	"landing-watch": "Landing, deployment receipts and the watch",
	budgets: "Tokens, spend, time and stopping",
	"self-hosting": "Run your own server",
	configuration: "Every environment variable",
	api: "The HTTP API",
	architecture: "How the pieces fit",
	lifecycle: "The quest state machine",
	journal: "What is stored in Git",
	trust: "What Ephyra refuses to pretend",
	troubleshooting: "Something is stuck or refused",
	glossary: "The words Ephyra uses",
};

/** Commands and loose words people type, mapped to the page that covers them. */
const ALIASES: Record<string, string> = {
	tui: "terminal",
	inbox: "terminal",
	keys: "terminal",
	login: "cli",
	doctor: "troubleshooting",
	stuck: "troubleshooting",
	help: "troubleshooting",
	error: "troubleshooting",
	decide: "reviewing",
	review: "reviewing",
	checkpoint: "reviewing",
	checkpoints: "reviewing",
	quests: "concepts",
	quest: "concepts",
	trails: "concepts",
	loop: "concepts",
	init: "quickstart",
	start: "quickstart",
	setup: "quickstart",
	agent: "agent-setup",
	agents: "agent-setup",
	handoff: "agent-setup",
	autonomy: "policy",
	land: "landing-watch",
	landing: "landing-watch",
	watch: "landing-watch",
	rollback: "landing-watch",
	usage: "budgets",
	spend: "budgets",
	budget: "budgets",
	cost: "budgets",
	env: "configuration",
	config: "configuration",
	host: "self-hosting",
	selfhost: "self-hosting",
	"self-host": "self-hosting",
	http: "api",
	git: "journal",
	refs: "journal",
	security: "trust",
	states: "lifecycle",
	state: "lifecycle",
	runs: "console",
	study: "study-evidence",
	words: "glossary",
};

/** The slug a topic names, or undefined. `ephyra docs` with no topic is the overview. */
export function docsTopic(topic: string | undefined): string | undefined {
	if (!topic) return "index";
	const key = topic.toLowerCase().replace(/^\/+|\.md$/g, "");
	if (key === "index" || key === "overview") return "index";
	return key in DOCS_TOPICS ? key : ALIASES[key];
}

export const docsUrl = (
	slug: string,
	env: Record<string, string | undefined> = process.env,
): string => (slug === "index" ? docsBase(env) : `${docsBase(env)}/${slug}`);
