// `ephyra doctor` and `ephyra handoff`: what is true about this machine, this repository and this server right
// now. Both only read. A check that could not run is reported as skipped, never as passing.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SetupRun } from "@ephyra/core";
import type { Client } from "../client";
import { docsBase, docsUrl } from "../docs";
import type { Credentials } from "../login";
import type { Check } from "./views";

export type RepoFacts = {
	isRepo: boolean;
	remote?: string;
	/** The remote URL with any embedded credentials removed. */
	url?: string;
	branch?: string;
	refspecs: { fetch: boolean; push: boolean };
	templates: string[];
};

const SPEC = "+refs/ephyra/*:refs/ephyra/*";
const TEMPLATES = ["autonomy.md", "thresholds.yaml", "models.yaml"];

/** Never print a remote's password or token: `https://user:secret@host/x.git` becomes `https://host/x.git`. */
export function withoutCredentials(url: string): string {
	try {
		const u = new URL(url);
		u.username = "";
		u.password = "";
		return u.href;
	} catch {
		return url.replace(/^([a-z+]+:\/\/)[^@/]*@/i, "$1");
	}
}

export function repoFacts(cwd: string, remote = "origin"): RepoFacts {
	const git = (...args: string[]) => {
		try {
			const r = Bun.spawnSync(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return r.exitCode === 0 ? r.stdout.toString().trim() : null;
		} catch {
			return null;
		}
	};
	const facts: RepoFacts = {
		isRepo: git("rev-parse", "--git-dir") !== null,
		refspecs: { fetch: false, push: false },
		templates: [],
	};
	if (!facts.isRepo) return facts;
	const top = git("rev-parse", "--show-toplevel") ?? cwd;
	const url = git("remote", "get-url", remote);
	if (url) {
		facts.remote = remote;
		facts.url = withoutCredentials(url);
	}
	const branch = git("rev-parse", "--abbrev-ref", "HEAD");
	if (branch && branch !== "HEAD") facts.branch = branch;
	for (const kind of ["fetch", "push"] as const)
		facts.refspecs[kind] = (
			git("config", "--get-all", `remote.${remote}.${kind}`) ?? ""
		)
			.split("\n")
			.includes(SPEC);
	facts.templates = TEMPLATES.filter((name) =>
		existsSync(join(top, "ephyra", name)),
	);
	return facts;
}

export type DoctorInput = {
	env: Record<string, string | undefined>;
	creds: Credentials | null;
	/** Set when a server URL and a credential are both known. */
	client: Client | null;
	url?: string;
	repo: RepoFacts;
	fetch: typeof fetch;
};
export type DoctorReport = {
	checks: Check[];
	setup: SetupRun | null;
	approver: boolean | null;
	principal: string | null;
};

export async function doctor(input: DoctorInput): Promise<DoctorReport> {
	const checks: Check[] = [];
	const report: DoctorReport = {
		checks,
		setup: null,
		approver: null,
		principal: null,
	};
	const { url, client, repo } = input;

	if (!url) {
		checks.push({
			name: "server",
			status: "fail",
			detail: "No Ephyra server is configured.",
			fix: "ephyra login <server-url>  (the hosted one is https://console.ephyra.quest), or set EPHYRA_URL.",
		});
	} else {
		try {
			const res = await input.fetch(new URL("/healthz", url));
			const body = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				mode?: string;
				store?: string;
				version?: string;
			};
			if (res.ok && body.ok !== false)
				checks.push(
					body.mode === "memory"
						? {
								name: "server",
								status: "warn",
								detail: `${url} is up, in memory mode${body.version ? ` (${body.version})` : ""}.`,
								fix: `Memory mode loses quests on restart. For anything you want to keep, see ${docsUrl("self-hosting", input.env)}`,
							}
						: {
								name: "server",
								status: "ok",
								detail: `${url} is up${body.mode ? `, ${body.mode} store` : ""}${body.version ? ` (${body.version})` : ""}.`,
							},
				);
			else
				checks.push({
					name: "server",
					status: "fail",
					detail: `${url} answered ${res.status}: its store is unavailable.`,
					fix: "The operator needs to check the server's logs and its Convex connection.",
				});
		} catch {
			checks.push({
				name: "server",
				status: "fail",
				detail: `${url} could not be reached.`,
				fix: "Check the address and your network. `ephyra login <server-url>` sets a different one.",
			});
		}
	}

	if (!client) {
		checks.push(
			input.env.EPHYRA_API_TOKEN && !input.env.EPHYRA_PRINCIPAL
				? {
						name: "sign-in",
						status: "fail",
						detail: "EPHYRA_API_TOKEN is set without EPHYRA_PRINCIPAL.",
						fix: "Set EPHYRA_PRINCIPAL to the name the audit log should record for this automation.",
					}
				: {
						name: "sign-in",
						status: "fail",
						detail: "Not signed in.",
						fix: url ? `ephyra login ${url}` : "ephyra login <server-url>",
					},
		);
	} else {
		try {
			const me = await client.me();
			report.approver = me.approver;
			report.principal = me.principal;
			const who = input.creds?.handle ?? me.principal;
			checks.push(
				me.approver
					? {
							name: "sign-in",
							status: "ok",
							detail: `Signed in as ${who} (${me.kind}); you can approve checkpoints.`,
						}
					: {
							name: "sign-in",
							status: "warn",
							detail: `Signed in as ${who} (${me.kind}), read-only.`,
							fix:
								me.kind === "service"
									? "A service token cannot approve once sign-in is required. Use `ephyra login` to decide as a person."
									: "Ask the workspace owner for Approver access (console → Team) if you need to decide checkpoints.",
						},
			);
		} catch (error) {
			checks.push({
				name: "sign-in",
				status: "fail",
				detail:
					error instanceof Error
						? error.message
						: "The session could not be checked.",
				fix: url ? `ephyra login ${url}` : "ephyra login <server-url>",
			});
		}
	}

	if (!repo.isRepo) {
		checks.push({
			name: "repository",
			status: "skip",
			detail:
				"This directory is not a Git repository, so local checks were skipped.",
		});
	} else {
		checks.push(
			repo.url
				? {
						name: "repository",
						status: "ok",
						detail: `${repo.remote} is ${repo.url}${repo.branch ? `, on ${repo.branch}` : ""}.`,
					}
				: {
						name: "repository",
						status: "warn",
						detail: "No `origin` remote.",
						fix: "Ephyra works on a repository it can fetch over HTTPS. Add a remote, or pass --remote to `ephyra init`.",
					},
		);
		if (repo.url && /^(git@|ssh:)/.test(repo.url))
			checks.push({
				name: "remote URL",
				status: "warn",
				detail: "The remote uses SSH.",
				fix: "Hosted setup needs the HTTPS URL of the same repository (and a scoped token if it is private).",
			});
		// Refspecs belong to a remote; without one there is nothing to check yet.
		if (repo.url)
			checks.push(
				repo.refspecs.fetch && repo.refspecs.push
					? {
							name: "journal refs",
							status: "ok",
							detail:
								"refs/ephyra/* is fetched and pushed, so quest journals travel with the repository.",
						}
					: {
							name: "journal refs",
							status: "warn",
							detail: "refs/ephyra/* is not in this remote's refspecs.",
							fix: "`ephyra init` adds it. Without it `git fetch` will not bring quest journals to your machine.",
						},
			);
		checks.push(
			repo.templates.length === TEMPLATES.length
				? {
						name: "policy files",
						status: "ok",
						detail:
							"ephyra/autonomy.md, thresholds.yaml and models.yaml are present.",
					}
				: {
						name: "policy files",
						status: "warn",
						detail: repo.templates.length
							? `Only ${repo.templates.join(", ")} found in ephyra/.`
							: "No ephyra/ policy files in this checkout.",
						fix: `\`ephyra init\` writes shadow-mode templates. The server may still hold policy of its own: \`ephyra policy\`. ${docsUrl("policy", input.env)}`,
					},
		);
	}

	if (client) {
		try {
			const setup = await client.setup();
			report.setup = setup;
			if (!setup)
				checks.push({
					name: "setup",
					status: "warn",
					detail: "No setup has run for this workspace.",
					fix: "Connect a repository in the console's Settings and start setup, or hand it to your agent with `ephyra handoff`.",
				});
			else if (setup.status === "ready")
				checks.push({
					name: "setup",
					status: "ok",
					detail: `Ready for ${setup.repository.url} (${setup.repository.branch}).`,
				});
			else if (setup.status === "queued" || setup.status === "running")
				checks.push({
					name: "setup",
					status: "warn",
					detail: `Setup is ${setup.status}.`,
					fix: "`ephyra setup` shows each step as it completes.",
				});
			else
				checks.push({
					name: "setup",
					status: "fail",
					detail:
						`Setup is ${setup.status}: ${setup.blockers.length} ` +
						`blocker${setup.blockers.length === 1 ? "" : "s"}${setup.blockers[0] ? `, first: ${setup.blockers[0].summary}` : ""}.`,
					fix: "`ephyra setup` lists every blocker and who has to act.",
				});
		} catch {
			checks.push({
				name: "setup",
				status: "skip",
				detail:
					"Setup status is not available to this credential on this server.",
			});
		}
		try {
			const inbox = await client.inbox();
			const blocking = inbox.filter((i) => i.blocking).length;
			checks.push(
				inbox.length
					? {
							name: "inbox",
							status: blocking ? "warn" : "ok",
							detail: `${inbox.length} waiting, ${blocking} blocking a quest.`,
							...(blocking
								? {
										fix: "`ephyra inbox` opens them. A blocking checkpoint holds its quest until a person answers.",
									}
								: {}),
						}
					: {
							name: "inbox",
							status: "ok",
							detail: "Nothing is waiting on a person.",
						},
			);
		} catch {
			checks.push({
				name: "inbox",
				status: "skip",
				detail: "The inbox could not be read.",
			});
		}
	}
	return report;
}

/** What `ephyra handoff` prints: a brief an agent can act on, with the facts filled in and no credential in it. */
export function handoffBrief(input: {
	url?: string;
	who?: string | null;
	repo: RepoFacts;
	report: DoctorReport;
	env: Record<string, string | undefined>;
}): string {
	const docs = docsBase(input.env);
	const { repo, report } = input;
	const repository =
		repo.url ??
		(repo.isRepo
			? "a Git repository with no origin remote"
			: "this directory is not a Git repository");
	const blockers = report.setup?.blockers
		.map((b) => `${b.summary} (${b.owner})`)
		.join("; ");
	const lines = [
		"I want your help with Ephyra, which turns production errors into reviewed, proven repairs on my repository.",
		"",
		`Start by reading ${docs}/agent.md. It is a brief written for coding agents: what Ephyra is, the rules, and links to every documentation page as Markdown.`,
		...(input.url
			? [
					`For access, follow ${input.url}/auth.md exactly. I approve the claim; you never see my credentials.`,
				]
			: []),
		"",
		"What is true here right now:",
		`- Ephyra server: ${input.url ?? "not chosen yet (the hosted one is https://console.ephyra.quest)"}`,
		`- Signed in as: ${input.who ?? "nobody on this machine yet"}${report.approver === false ? " (read-only)" : ""}`,
		`- Repository: ${repository}${repo.branch ? `, branch ${repo.branch}` : ""}`,
		`- Journal refspecs (refs/ephyra/*): ${repo.refspecs.fetch && repo.refspecs.push ? "configured" : "not configured"}`,
		`- Policy files in ephyra/: ${repo.templates.length ? repo.templates.join(", ") : "none"}`,
		...(report.setup
			? [
					`- Recorded setup: ${report.setup.status}${blockers ? `; blocked on: ${blockers}` : ""}`,
				]
			: ["- Recorded setup: none, or not readable from here"]),
		"",
		"What `ephyra doctor` reported:",
		...report.checks.map(
			(c) =>
				`- [${c.status}] ${c.name}: ${c.detail}${c.fix && c.status !== "ok" ? ` Next: ${c.fix}` : ""}`,
		),
		"",
		"What I want from you:",
		"1. Tell me what you found before changing anything, in plain language.",
		"2. Work through whatever is failing or missing above, in order. Ask me for anything only I can provide: expected behavior, credentials, model " +
			"access, approvals.",
		"3. Report only checks and observations that actually happened. If something could not be verified, say so; do not describe it as working.",
		"4. Never put a token or key in a file, a commit, a prompt or this chat. Checkpoint decisions, spending and landing are mine to make.",
	];
	return lines.join("\n");
}
