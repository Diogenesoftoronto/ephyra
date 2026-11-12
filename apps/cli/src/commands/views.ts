// What the read commands print. Pure functions from API shapes to styled lines, like the inbox view, so the
// same output is tested as text and coloured only on a terminal. Everything agent- or server-written goes
// through oneLine/clean before it reaches a line.
import type {
	ActivityItem,
	AgentRun,
	AgentRunEvent,
	InvestigationQuestion,
	PolicyActivationReceipt,
	SetupRun,
	UsageSummary,
	UsageTotals,
} from "@ephyra/core";
import type { AgentAccess, PolicyDocSummary } from "../client";
import { usd } from "../inbox/story";
import { clean, oneLine, trunc, wrap } from "../inbox/text";
import { row, type Line, type Seg, type Tone } from "../inbox/view";

const g = (text: string, tone: Tone = "fg", bold = false): Seg =>
	bold ? { text, tone, bold } : { text, tone };
const fitW = (w: number) => Math.max(40, Math.floor(w));
const finish = (lines: Line[], w: number) => lines.map((l) => row(l, fitW(w)));
const col = (text: string, w: number) => trunc(oneLine(text), w - 1).padEnd(w);

/** "3m ago", "2h ago", "4d ago"; a date once it is older than a month. */
export function ago(iso: string, now: Date): string {
	const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
	if (!Number.isFinite(s)) return "";
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
	return iso.slice(0, 10);
}
const span = (ms: number) =>
	ms < 1000
		? `${ms}ms`
		: ms < 60_000
			? `${Math.round(ms / 1000)}s`
			: ms < 3_600_000
				? `${Math.round(ms / 60_000)}m`
				: `${(ms / 3_600_000).toFixed(1)}h`;
const count = (n: number) =>
	n >= 1e6
		? `${(n / 1e6).toFixed(1)}M`
		: n >= 1e3
			? `${(n / 1e3).toFixed(1)}k`
			: String(n);
const RUN_TONE: Record<AgentRun["status"], Tone> = {
	running: "mint",
	done: "amber",
	failed: "cherry",
	unavailable: "cherry",
};

/** A cost that may be unknown. Unknown is said, never shown as $0.00. */
const cost = (microusd: number | null | undefined) =>
	microusd === null || microusd === undefined ? "unknown" : usd(microusd);

export function runsView(runs: AgentRun[], w = 80, now = new Date()): Line[] {
	if (!runs.length)
		return finish(
			[
				[g("No agent runs yet.", "muted")],
				[
					g(
						"Runs appear when a quest reaches a step an agent works: research, reproduction, plan, patch, review.",
						"muted",
					),
				],
			],
			w,
		);
	// The engine comes last and is not cut to a column: it is an identity, recorded exactly as the backend returned it.
	const out: Line[] = [
		[
			g("run".padEnd(14), "muted"),
			g("quest".padEnd(10), "muted"),
			g("step".padEnd(12), "muted"),
			g("status".padEnd(13), "muted"),
			g("started".padEnd(11), "muted"),
			g("engine", "muted"),
		],
	];
	for (const r of runs)
		out.push([
			g(col(r.id, 14), "strong"),
			g(col(r.short ?? "-", 10)),
			g(col(r.step, 12)),
			g(col(r.status, 13), RUN_TONE[r.status]),
			g(col(ago(r.startedAt, now), 11), "muted"),
			g(oneLine(r.engine)),
		]);
	out.push(
		[],
		[
			g("ephyra run <run> ", "strong"),
			g("reads a transcript; ", "muted"),
			g("--follow ", "strong"),
			g("keeps reading while it runs", "muted"),
		],
	);
	return finish(out, w);
}

function eventLines(e: AgentRunEvent, w: number): Line[] {
	const at = e.at.slice(11, 19);
	const lead = (label: string, tone: Tone): Seg[] => [
		g(`${at}  `, "dim"),
		g(label.padEnd(9), tone, true),
	];
	const body = (text: string, tone: Tone = "fg", max = 12) => {
		const lines = clean(text)
			.split("\n")
			.flatMap((l) => wrap(l, Math.max(20, w - 19)));
		const shown = lines
			.slice(0, max)
			.map((t) => [g(" ".repeat(19)), g(t, tone)] as Line);
		if (lines.length > max)
			shown.push([
				g(" ".repeat(19)),
				g(`… ${lines.length - max} more lines (--json has all of it)`, "dim"),
			]);
		return shown;
	};
	if (e.type === "policy" && e.policy)
		return [
			[
				...lead("policy", e.policy.decision === "allow" ? "amber" : "cherry"),
				g(`${e.policy.decision} `, "strong"),
				g(
					oneLine(
						`${e.tool?.name ?? ""} · ${e.policy.rule}: ${e.policy.reason}`,
					),
					"muted",
				),
			],
		];
	if (e.type === "tool_call" && e.tool)
		return [
			[...lead("tool", "muted"), g(oneLine(e.tool.name), "strong")],
			...(e.tool.args ? body(e.tool.args, "muted", 3) : []),
		];
	if (e.type === "tool_result" && e.tool)
		return [
			[
				...lead(
					e.tool.isError ? "failed" : "result",
					e.tool.isError ? "cherry" : "muted",
				),
				g(oneLine(e.tool.name), "muted"),
			],
			...(e.tool.result ? body(e.tool.result, "muted", 4) : []),
		];
	if (e.type === "portal")
		return [[...lead("preview", "mint"), g(oneLine(e.portalUrl ?? ""))]];
	const label =
		e.type === "reasoning"
			? "thinking"
			: e.type === "status"
				? "status"
				: "agent";
	const first = body(e.text ?? "", e.type === "message" ? "fg" : "muted");
	return first.length
		? [
				[
					...lead(label, e.type === "message" ? "amber" : "muted"),
					...first[0]!.slice(1),
				],
				...first.slice(1),
			]
		: [];
}

export function runView(
	run: AgentRun,
	events: AgentRunEvent[],
	w = 80,
	now = new Date(),
): Line[] {
	w = fitW(w);
	const out: Line[] = [
		[
			g(run.id, "strong", true),
			g("  "),
			g(run.status, RUN_TONE[run.status], true),
			g(`  ${run.step}${run.short ? ` on ${run.short}` : ""}`, "muted"),
		],
		[
			g("engine    ", "muted"),
			g(oneLine(run.engine)),
			g(`   executor ${run.executor.kind}`, "muted"),
		],
		[
			g("started   ", "muted"),
			g(`${ago(run.startedAt, now)}`),
			...(run.endedAt
				? [
						g(
							`   took ${span(Date.parse(run.endedAt) - Date.parse(run.startedAt))}`,
							"muted",
						),
					]
				: []),
		],
	];
	if (run.usage)
		out.push([
			g("usage     ", "muted"),
			g(
				`${run.usage.tokens === null ? "unknown" : count(run.usage.tokens)} tokens · ${cost(run.usage.costMicrousd)}`,
			),
		]);
	if (run.executor.threadUrl)
		out.push([g("thread    ", "muted"), g(oneLine(run.executor.threadUrl))]);
	if (run.error)
		out.push([g("error     ", "cherry"), g(oneLine(run.error), "cherry")]);
	out.push([]);
	if (!events.length)
		out.push([g("No events recorded for this run.", "muted")]);
	for (const e of events) out.push(...eventLines(e, w));
	return finish(out, w);
}
/** Just the event lines, for `run --follow` to append as they arrive. */
export const runEventsView = (events: AgentRunEvent[], w = 80): Line[] =>
	finish(
		events.flatMap((e) => eventLines(e, fitW(w))),
		w,
	);

const totalsLine = (t: UsageTotals): Seg[] => [
	g(usd(t.costMicrousd), "strong", true),
	g(" known spend", "muted"),
	...(t.unknownCost
		? [g(`  +${t.unknownCost} with unknown cost`, "cherry")]
		: []),
	g(
		`  ${count(t.tokens)} tokens  ${span(t.wallMs)} of work  ${t.entries} entries`,
		"muted",
	),
	...(t.failed + t.unavailable
		? [g(`  ${t.failed} failed, ${t.unavailable} unavailable`, "cherry")]
		: []),
];

export function usageView(u: UsageSummary, w = 80): Line[] {
	const out: Line[] = [
		[g("usage ", "muted"), g(`${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}`)],
		totalsLine(u.totals),
	];
	if (u.totals.unknownCost)
		out.push([
			g(
				"The spend above is a lower bound: unknown costs are not counted as zero.",
				"muted",
			),
		]);
	const peak = Math.max(1, ...u.byDay.map((d) => d.totals.costMicrousd));
	if (u.byDay.length) {
		out.push([], [g("by day", "muted")]);
		for (const d of u.byDay) {
			const bar = "█".repeat(Math.round((d.totals.costMicrousd / peak) * 24));
			out.push([
				g(`  ${d.key.slice(5)}  `, "muted"),
				g(bar.padEnd(25), "amber"),
				g(usd(d.totals.costMicrousd).padStart(8)),
				g(
					d.totals.unknownCost ? `  +${d.totals.unknownCost} unknown` : "",
					"cherry",
				),
			]);
		}
	}
	if (u.byEngine.length) {
		out.push([], [g("by engine", "muted")]);
		for (const e of u.byEngine)
			out.push([
				g("  "),
				g(col(e.key, 34)),
				g(usd(e.totals.costMicrousd).padStart(9)),
				g(`  ${count(e.totals.tokens)} tokens`, "muted"),
				g(
					e.totals.unknownCost ? `  +${e.totals.unknownCost} unknown` : "",
					"cherry",
				),
			]);
	}
	if (u.byTrail.length) {
		out.push([], [g("by quest (budget used)", "muted")]);
		for (const t of u.byTrail) {
			const tokens = t.budget.tokensMax
				? `${count(t.budget.tokensUsed)}/${count(t.budget.tokensMax)} tokens`
				: `${count(t.budget.tokensUsed)} tokens`;
			const spend = t.budget.spendMicrousdMax
				? `${usd(t.budget.spendMicrousdUsed)}/${usd(t.budget.spendMicrousdMax)}`
				: `${usd(t.budget.spendMicrousdUsed)} (no metered allowance)`;
			const near =
				t.budget.tokensMax > 0 &&
				t.budget.tokensUsed / t.budget.tokensMax >= 0.8;
			out.push([
				g("  "),
				g(col(t.short, 10), "strong"),
				g(col(tokens, 24), near ? "cherry" : "fg"),
				g(col(spend, 30), "muted"),
				g(oneLine(t.title), "muted"),
			]);
		}
	}
	if (!u.totals.entries)
		out.push(
			[],
			[
				g(
					"Nothing recorded in this window. Usage appears when a model or an agent step actually runs.",
					"muted",
				),
			],
		);
	return finish(out, w);
}

const ACT_TONE: Record<ActivityItem["status"], Tone> = {
	running: "mint",
	done: "amber",
	failed: "cherry",
	waiting: "mint",
};
export function activityView(
	items: ActivityItem[],
	w = 80,
	now = new Date(),
): Line[] {
	if (!items.length) return finish([[g("No activity yet.", "muted")]], w);
	return finish(
		items.map((a) => [
			g(ago(a.at, now).padEnd(10), "muted"),
			g(col(a.status, 9), ACT_TONE[a.status]),
			g(col(a.short ?? "-", 10), "strong"),
			g(col(a.persona ?? "-", 8), "muted"),
			g(oneLine(a.summary)),
		]),
		w,
	);
}

export function policyView(
	active: PolicyActivationReceipt | null,
	docs: PolicyDocSummary[],
	w = 80,
	now = new Date(),
): Line[] {
	const out: Line[] = [];
	if (active)
		out.push(
			[
				g("active policy  ", "muted"),
				g(active.commit.slice(0, 12), "amber", true),
				g(
					`  activated ${ago(active.at, now)} by ${oneLine(active.principal)}`,
					"muted",
				),
			],
			[
				g("from           ", "muted"),
				g(`${oneLine(active.path)} at ${active.sourceCommit.slice(0, 12)}`),
			],
		);
	else
		out.push(
			[g("active policy  ", "muted"), g("none activated", "strong")],
			...wrap(
				"The server is using the policy it loaded at start (or the shadow-mode templates). A published draft takes effect only when an approver activates it.",
				fitW(w),
			).map((t) => [g(t, "muted")] as Line),
		);
	out.push([], [g("documents", "muted")]);
	for (const d of docs) {
		const errors = d.warnings.filter((x) => x.startsWith("error:")).length;
		const warnings = d.warnings.length - errors;
		out.push([
			g("  "),
			g(col(d.path, 30), "strong"),
			g(col(d.kind, 12), "muted"),
			errors
				? g(`${errors} error${errors > 1 ? "s" : ""}`, "cherry")
				: warnings
					? g(`${warnings} warning${warnings > 1 ? "s" : ""}`, "mint")
					: g("ok", "amber"),
			g(`  ${d.digest.slice(0, 10)}`, "dim"),
		]);
		for (const text of d.warnings.slice(0, 4))
			out.push([
				g("      "),
				g(oneLine(text), text.startsWith("error:") ? "cherry" : "muted"),
			]);
	}
	if (!docs.length) out.push([g("  none", "muted")]);
	return finish(out, w);
}

const STEP_TONE: Record<SetupRun["steps"][number]["status"], Tone> = {
	pending: "muted",
	running: "mint",
	complete: "amber",
	blocked: "cherry",
	failed: "cherry",
};
const STEP_MARK: Record<SetupRun["steps"][number]["status"], string> = {
	pending: "·",
	running: "›",
	complete: "✓",
	blocked: "!",
	failed: "✗",
};
const COVER_TONE = {
	observed: "amber",
	configured: "mint",
	missing: "cherry",
	unknown: "muted",
} as const;

export function setupView(
	run: SetupRun | null,
	w = 80,
	now = new Date(),
): Line[] {
	w = fitW(w);
	if (!run)
		return finish(
			[
				[g("No setup has been recorded for this workspace.", "strong")],
				...wrap(
					"Connect a repository in the console's Settings, then start setup there (or let your coding agent do it: `ephyra handoff`).",
					w,
				).map((t) => [g(t, "muted")] as Line),
			],
			w,
		);
	const tone: Tone =
		run.status === "ready"
			? "amber"
			: run.status === "blocked" || run.status === "failed"
				? "cherry"
				: "mint";
	const out: Line[] = [
		[
			g("setup  ", "muted"),
			g(run.status, tone, true),
			g(`  ${run.mode}  updated ${ago(run.updatedAt, now)}`, "muted"),
		],
		[
			g("repo   ", "muted"),
			g(
				oneLine(
					`${run.repository.url} · ${run.repository.branch} @ ${run.repository.head.slice(0, 12)}`,
				),
			),
		],
		[],
	];
	for (const s of run.steps) {
		out.push([
			g(` ${STEP_MARK[s.status]} `, STEP_TONE[s.status], true),
			g(col(s.name, 30), "strong"),
			g(s.status, STEP_TONE[s.status]),
		]);
		if (s.detail && s.status !== "complete")
			for (const t of wrap(oneLine(s.detail), w - 6).slice(0, 3))
				out.push([g("     "), g(t, "muted")]);
	}
	const coverage = run.bootstrap?.coverage;
	if (coverage?.length) {
		out.push([], [g("what Ephyra can observe", "muted")]);
		for (const c of coverage) {
			out.push([
				g("   "),
				g(col(c.id, 12), "strong"),
				g(col(c.status, 12), COVER_TONE[c.status]),
			]);
			for (const t of wrap(oneLine(c.summary), w - 6).slice(0, 2))
				out.push([g("     "), g(t, "muted")]);
		}
		out.push([
			g(
				"   observed = seen happening · configured = connected, not yet seen · missing · unknown",
				"dim",
			),
		]);
	}
	if (run.blockers.length) {
		out.push([], [g("blocking the loop", "cherry", true)]);
		for (const b of run.blockers) {
			out.push([
				g(" ! ", "cherry", true),
				g(oneLine(b.summary), "strong"),
				g(`  (${b.owner})`, "muted"),
			]);
			for (const t of wrap(oneLine(b.action), w - 6))
				out.push([g("     "), g(t)]);
		}
	} else if (run.status === "ready")
		out.push([], [g("Nothing is blocking the loop.", "amber")]);
	const open =
		run.bootstrap?.requests?.filter((r) => r.status === "open") ?? [];
	if (open.length) {
		out.push(
			[],
			[
				g(
					`${open.length} question${open.length > 1 ? "s" : ""} for you`,
					"mint",
					true,
				),
				g("  (answer them in the console's inbox)", "muted"),
			],
		);
		for (const r of open.slice(0, 5))
			for (const [i, t] of wrap(oneLine(r.question), w - 6)
				.slice(0, 2)
				.entries())
				out.push([g(i ? "     " : "   ? ", "mint"), g(t)]);
	}
	return finish(out, w);
}

const Q_TONE: Record<InvestigationQuestion["status"], Tone> = {
	checking: "muted",
	awaiting_answer: "mint",
	answered: "amber",
	rejected: "cherry",
	ambiguous: "cherry",
	superseded: "muted",
};
export function questionsView(
	questions: InvestigationQuestion[],
	w = 80,
	now = new Date(),
): Line[] {
	w = fitW(w);
	if (!questions.length)
		return finish(
			[[g("No investigation is waiting on an answer from you.", "muted")]],
			w,
		);
	const out: Line[] = [];
	for (const q of questions) {
		out.push([
			g(q.id.slice(0, 10), "strong", true),
			g(`  ${q.status.replace("_", " ")}`, Q_TONE[q.status]),
			g(`  asked ${ago(q.createdAt, now)}`, "muted"),
		]);
		for (const t of wrap(oneLine(q.question), w - 2)) out.push([g("  "), g(t)]);
		for (const t of wrap(`Why: ${oneLine(q.reason)}`, w - 2).slice(0, 2))
			out.push([g("  "), g(t, "muted")]);
		if (q.answer)
			for (const t of wrap(`Answered: ${oneLine(q.answer.text)}`, w - 2).slice(
				0,
				2,
			))
				out.push([g("  "), g(t, "amber")]);
		out.push([]);
	}
	if (questions.some((q) => q.status === "awaiting_answer"))
		out.push([
			g('ephyra answer <id> -m "…"', "strong"),
			g("  answers one with a fact you know", "muted"),
		]);
	return finish(out, w);
}

export function agentsView(
	agents: AgentAccess[],
	w = 80,
	now = new Date(),
): Line[] {
	if (!agents.length)
		return finish(
			[
				[g("No coding agent has access.", "muted")],
				[
					g(
						"`ephyra handoff` prints a brief that lets your agent ask for it.",
						"muted",
					),
				],
			],
			w,
		);
	const out: Line[] = [];
	for (const a of agents) {
		const expired = Date.parse(a.expiresAt) <= now.getTime();
		const state = a.revokedAt
			? g("revoked", "cherry")
			: expired
				? g("expired", "muted")
				: g("active", "amber");
		out.push(
			[
				g(col(a.id, 26), "strong", true),
				state,
				g(
					`  approved ${ago(a.createdAt, now)}, expires ${a.expiresAt.slice(0, 10)}`,
					"muted",
				),
			],
			[g("  "), g(oneLine(`${a.repository.url} · ${a.repository.branch}`))],
			[g("  "), g(a.scopes.join(", "), "muted")],
			[],
		);
	}
	out.push([
		g("ephyra agents revoke <id>", "strong"),
		g("  ends an agent's access now", "muted"),
	]);
	return finish(out, w);
}

export type Check = {
	name: string;
	status: "ok" | "warn" | "fail" | "skip";
	detail: string;
	fix?: string;
};
const CHECK_MARK: Record<Check["status"], [string, Tone]> = {
	ok: ["✓", "amber"],
	warn: ["!", "mint"],
	fail: ["✗", "cherry"],
	skip: ["·", "muted"],
};

export function doctorView(checks: Check[], w = 80): Line[] {
	w = fitW(w);
	const out: Line[] = [];
	for (const c of checks) {
		const [mark, tone] = CHECK_MARK[c.status];
		const detail = wrap(oneLine(c.detail), w - 20);
		out.push([
			g(` ${mark} `, tone, true),
			g(c.name.padEnd(16), "strong"),
			g(detail[0] ?? "", c.status === "skip" ? "muted" : "fg"),
		]);
		for (const t of detail.slice(1)) out.push([g(" ".repeat(19)), g(t)]);
		if (c.fix && c.status !== "ok")
			for (const [i, t] of wrap(c.fix, w - 22).entries())
				out.push([
					g(" ".repeat(19)),
					g(i ? "  " : "→ ", "mint"),
					g(t, "muted"),
				]);
	}
	const fails = checks.filter((c) => c.status === "fail").length,
		warns = checks.filter((c) => c.status === "warn").length;
	out.push(
		[],
		fails
			? [
					g(
						`${fails} thing${fails > 1 ? "s" : ""} to fix before the loop can run here.`,
						"cherry",
						true,
					),
				]
			: warns
				? [
						g(
							`Working, with ${warns} thing${warns > 1 ? "s" : ""} worth a look.`,
							"mint",
							true,
						),
					]
				: [g("Everything checked out.", "amber", true)],
	);
	return finish(out, w);
}
