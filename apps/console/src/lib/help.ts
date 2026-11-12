// What the console says about itself: for each screen, what it is for, a few things worth knowing, and the
// documentation page that covers it. The help menu, tip toasts and agent brief all read this table.
import type { PageId } from "../app/route.ts";

/** Works with or without a dedicated docs host: the public site redirects /docs/<page> there when one is configured. */
export const DOCS_URL = ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_EPHYRA_DOCS_URL || "https://ephyra.quest/docs").replace(/\/+$/, "");
export const docsUrl = (slug: string): string => (slug === "index" ? DOCS_URL : `${DOCS_URL}/${slug}`);

export type Tip = {
  /** Stable across releases: dismissing a tip is remembered by this. */
  id: string;
  text: string;
  /** A docs page, optionally with an anchor: "policy#five-levels". */
  docs?: string;
};
export type ScreenHelp = { title: string; about: string; tips: readonly Tip[]; docs: string };

export const HELP: Record<PageId, ScreenHelp> = {
  loop: {
    title: "The loop", docs: "console#loop",
    about: "Every quest the server holds, where each one is, and the one thing, if any, that needs you.",
    tips: [
      { id: "loop-keys", text: "j and k walk the quests. a then Enter does the waiting action: two keys, so a stray press never " +
        "approves anything.", docs: "console#loop" },
      { id: "loop-hood", text: "Press i on a quest to open its journal, events and files under the hood.", docs: "journal" },
      { id: "loop-quiet", text: "A quiet loop is normal until a signal arrives. Setup shows whether anything is blocking it " +
        "from starting.", docs: "troubleshooting#nothing-is-happening" },
    ],
  },
  overview: {
    title: "Overview", docs: "console",
    about: "Waiting decisions, recent activity, recent spend and the quests closest to their budgets.",
    tips: [
      { id: "overview-budgets", text: "The three budgets shown are the ones with the highest usage. Usage lists every quest.", docs: "budgets" },
    ],
  },
  inbox: {
    title: "Inbox", docs: "reviewing",
    about: "The decisions waiting on a person, and for each one exactly what you are asked to judge.",
    tips: [
      { id: "inbox-evidence", text: "Read the evidence before the summary. The summary was written by the agent whose work you " +
        "are checking.", docs: "reviewing#before-any-of-them" },
      { id: "inbox-bound", text: "Your answer is bound to the revision on screen. If the quest moves first, it is refused as stale and " +
        "you look again.", docs: "reviewing" },
      { id: "inbox-revise", text: "Sending a checkpoint back with a note is normal. The agent works on what you wrote and returns to the " +
        "same checkpoint.", docs: "reviewing#your-options-side-by-side" },
    ],
  },
  runs: {
    title: "Runs", docs: "console#runs",
    about: "Every agent step: which engine ran it, where, how it ended, and its full transcript.",
    tips: [
      { id: "runs-transcript", text: "When a patch surprises you, read the run that wrote it before the diff. It shows what the agent looked at and what " +
        "policy refused.", docs: "console#runs" },
    ],
  },
  usage: {
    title: "Usage", docs: "budgets",
    about: "Tokens, spend and time for the window, by day, engine and quest, beside each quest's budget.",
    tips: [
      { id: "usage-unknown", text: "A cost a provider did not report is counted as unknown, never as zero. A total with unknown entries is a " +
        "lower bound.", docs: "budgets#unknown-costs" },
      { id: "usage-retry", text: "Retrying does not reset a quest's budget, and time spent waiting at a checkpoint is " +
        "not counted.", docs: "budgets#three-ceilings-per-quest" },
    ],
  },
  workspace: {
    title: "Workspace", docs: "policy",
    about: "What Ephyra may do in your code: the application map and the policy documents behind it.",
    tips: [
      { id: "workspace-levels", text: "Setup starts with one area for the whole repository. Split out the parts you trust least and give them a " +
        "lower level.", docs: "policy#where-you-start" },
      { id: "workspace-activate", text: "Publishing writes a reviewed draft to Git. Nothing changes until an approver " +
        "activates it.", docs: "policy#editing-policy-in-the-console" },
      { id: "workspace-risk", text: "High and critical areas always need a named person at checkpoint C, whatever " +
        "the level says.", docs: "policy#risk-overrides-the-level" },
    ],
  },
  personas: {
    title: "Personas", docs: "console#personas",
    about: "Six named roles do the work. Each shows the engine it actually used and what it has spent.",
    tips: [{ id: "personas-roles", text: "Personas are roles, not models. The engine beside each one is the identity the " +
      "backend reported.", docs: "glossary#people-and-parts" }],
  },
  team: {
    title: "Team", docs: "console#team",
    about: "Who can see this workspace and who can approve in it.",
    tips: [{ id: "team-roles", text: "A Viewer reads everything and decides nothing. Only an Approver can answer a checkpoint. Invitations " +
      "are single-use.", docs: "console#team" }],
  },
  account: {
    title: "Your account", docs: "console#your-account",
    about: "Your Not Organic profile, this browser's appearance and sound preferences, and your current session.",
    tips: [
      { id: "account-profile", text: "Edit your name, handle and picture in Not Organic. Return here to refresh your profile.",
        docs: "console#your-account" },
      { id: "account-theme", text: "Use the sun and moon to choose Light or Dark. Your choice is remembered in this browser.",
        docs: "console#your-account" },
    ],
  },
  settings: {
    title: "Settings", docs: "connections",
    about: "The connections the loop depends on: repository, models, telemetry, knowledge and people.",
    tips: [
      { id: "settings-https", text: "Use the repository's HTTPS address and a token scoped to that one repository. SSH and private-network addresses are not " +
        "accepted here.", docs: "connections#repository" },
      { id: "settings-configured", text: "Saving a key checks that it works; it does not prove anything arrived. Setup reports configured and " +
        "observed separately.", docs: "quickstart#4-read-what-setup-found" },
    ],
  },
  onboarding: {
    title: "Setup", docs: "quickstart",
    about: "The recorded setup: each step, what Ephyra can observe, and what is blocking the loop.",
    tips: [
      { id: "setup-blockers", text: "Each blocker names who has to act: you, or whoever runs the server. A connected repository is the first step, " +
        "not the last.", docs: "quickstart#5-deal-with-the-blockers" },
      { id: "setup-agent", text: "Your coding agent can do most of setup. Help → Copy a brief for your agent.", docs: "agent-setup" },
    ],
  },
};

const DISMISSED = "ephyra.tips.dismissed";
const OFF = "ephyra.tips.off";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const safe = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

export function dismissedTips(store: Store | null = safe()): string[] {
  try {
    const value: unknown = JSON.parse(store?.getItem(DISMISSED) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}
export const tipsOff = (store: Store | null = safe()): boolean => { try { return store?.getItem(OFF) === "1"; } catch { return false; } };
export function dismissTip(id: string, store: Store | null = safe()): void {
  try { store?.setItem(DISMISSED, JSON.stringify([...new Set([...dismissedTips(store), id])].slice(-200))); } catch { /* storage may be blocked */ }
}
export function setTipsOff(off: boolean, store: Store | null = safe()): void {
  try { if (off) store?.setItem(OFF, "1"); else { store?.removeItem(OFF); store?.removeItem(DISMISSED); } } catch { /* storage may be blocked */ }
}
/** The next tip for a screen that has not been dismissed, or undefined when there is none or tips are off. */
export const nextTip = (page: PageId, dismissed: readonly string[], off: boolean): Tip | undefined =>
  off ? undefined : HELP[page].tips.find((tip) => !dismissed.includes(tip.id));

/** A repository address without anything that could be a credential. */
export function publicRepository(url: string | undefined | null): string | null {
  if (!url) return null;
  try { const u = new URL(url); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.href; } catch { return null; }
}

/** What "Copy a brief for your agent" puts on the clipboard. It names where things are; it never contains a credential. */
export type AgentBriefInput = {
  server: string; page: PageId; repository?: string | null; branch?: string | null; setupStatus?: string | null; demo?: boolean;
};
export function agentBrief(input: AgentBriefInput): string {
  const help = HELP[input.page];
  const repository = publicRepository(input.repository);
  return [
    "I want your help with Ephyra, which turns production errors into reviewed, proven repairs on my repository.",
    "",
    `Start by reading ${DOCS_URL}/agent.md. It is a brief written for coding agents: what Ephyra is, the rules, and links to every documentation page ` +
      `as Markdown.`,
    ...(input.demo ? [] : [`For access, follow ${input.server}/auth.md exactly. I approve the claim; you never see my credentials.`]),
    "",
    "What is true here right now:",
    `- Ephyra server: ${input.demo ? "none yet (I am looking at the demo)" : input.server}`,
    `- Repository: ${repository ?? "not connected yet"}${repository && input.branch ? `, branch ${input.branch}` : ""}`,
    ...(input.setupStatus ? [`- Setup: ${input.setupStatus}`] : []),
    `- I am on the console's ${help.title} screen. The page about it: ${docsUrl(help.docs.split("#")[0]!)}.md`,
    "",
    "What I want from you:",
    "1. Tell me what you found before changing anything, in plain language.",
    "2. Ask me for anything only I can provide: expected behavior, credentials, model access, approvals.",
    "3. Report only checks and observations that actually happened. If something could not be verified, say so.",
    "4. Never put a token or key in a file, a commit, a prompt or this chat. Checkpoint decisions, spending and landing are mine to make.",
  ].join("\n");
}
