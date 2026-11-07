// AmpAgent: runs trail steps as turns of one Amp thread per trail, locally, in an Amp orb, or on an Amp runner.
// Speaks the Amp CLI's stream-json directly (the same arguments @ampcode/sdk builds in buildCliArgs), so Ephyra
// needs no SDK dependency and the command runs inside any Ephyra runner. See design/03-amp-integration.md.
import { Unverified, type AgentResult, type AgentTask, type CodingAgent, type Runner, type RunnerHandle } from "@ephyra/core";
import { renderPrompt } from "./prompts";
import { execute } from "./execute";
import { collectSessions } from "./sessions";

export type AmpExecutor =
  | { kind: "local" }
  /** Amp cloud sandbox. `project` is an Amp project (namespace/name or repository URL). */
  | { kind: "orb"; project?: string }
  /** An `amp --no-tui --runner-id <id>` process on the user's own machine. */
  | { kind: "runner"; runnerId: string; runnerDir?: string };

export type AmpOptions = {
  executor: AmpExecutor;
  mode?: "low" | "medium" | "high" | "ultra";
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Default workspace, so approvers can watch and take over; use private for sensitive areas. */
  visibility?: "private" | "unlisted" | "workspace" | "group";
  /** Where to remember each trail's thread id (the server keeps it in the journal). */
  threads: AmpThreadStore;
};

export interface AmpThreadStore {
  get(trailId: string): Promise<string | null>;
  set(trailId: string, threadId: string): Promise<void>;
}

export class MemoryAmpThreads implements AmpThreadStore {
  private map = new Map<string, string>();
  async get(trailId: string) { return this.map.get(trailId) ?? null; }
  async set(trailId: string, threadId: string) { this.map.set(trailId, threadId); }
}

/** Amp thread ids look like T-01a1b539-866f-77a3-833f-b417d7707bbd. */
const THREAD_ID = /^T-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** CLI arguments for one turn; mirrors @ampcode/sdk buildCliArgs for the options Ephyra uses. */
export function ampArgs(task: AgentTask, options: AmpOptions, threadId: string | null): string[] {
  const args = ["amp"];
  if (threadId) {
    if (!THREAD_ID.test(threadId)) throw new Error(`invalid Amp thread id: ${threadId}`);
    args.push("threads", "continue", threadId);
  }
  args.push("--execute", "--stream-json");
  const ex = options.executor;
  if (ex.kind === "orb") {
    args.push("--orb-execute");
    if (ex.project && !threadId) args.push("--project", ex.project);
  } else if (ex.kind === "runner") {
    args.push("--executor", `runner:${ex.runnerId}`);
    if (ex.runnerDir && !threadId) args.push("--runner-dir", ex.runnerDir);
  }
  args.push("--no-archive-after-execute", "--no-notifications", "--no-ide");
  args.push("--visibility", options.visibility ?? "workspace");
  if (options.mode) args.push("--mode", options.mode);
  if (options.effort) args.push("--effort", options.effort);
  if (!threadId) {
    args.push("--title", `${task.trail.short} ${task.trail.title}`.slice(0, 256));
    args.push("--label", "ephyra", "--label", `trail-${task.trail.short.toLowerCase()}`);
  }
  args.push("--label", `step-${task.step}`);
  args.push(renderPrompt(task));
  return args;
}

type StreamMessage = Record<string, any>;

export type AmpTurn = {
  threadId: string;
  ok: boolean;
  text: string;
  error?: string;
  subtype: string;
  numTurns: number;
  durationMs: number;
  tokens: number;
  permissionDenials: string[];
  toolUses: string[];
};

/** Parse the CLI's stream-json (Claude Code compatible). Exactly one `result` message ends a turn. */
export function parseAmpStream(stdout: string): AmpTurn {
  const messages: StreamMessage[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      throw new Unverified("Amp stream-json output");
    }
  }
  const system = messages.find((m) => m.type === "system" && m.subtype === "init");
  const result = messages.find((m) => m.type === "result");
  const threadId = result?.session_id ?? system?.session_id;
  if (!result || typeof threadId !== "string") throw new Unverified("Amp turn produced no result");
  const toolUses = messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => (m.message?.content ?? []) as { type: string; name?: string }[])
    .filter((c) => c.type === "tool_use" && c.name)
    .map((c) => c.name!);
  const usage = result.usage ?? {};
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
  return {
    threadId, ok: result.is_error === false, text: typeof result.result === "string" ? result.result : "",
    ...(result.is_error ? { error: String(result.error ?? result.subtype) } : {}),
    subtype: String(result.subtype), numTurns: Number(result.num_turns ?? 0), durationMs: Number(result.duration_ms ?? 0),
    tokens, permissionDenials: Array.isArray(result.permission_denials) ? result.permission_denials : [], toolUses,
  };
}

export class AmpAgent implements CodingAgent {
  readonly name = "amp";
  constructor(private readonly options: AmpOptions) {}

  async run(task: AgentTask, runner: Runner, handle: RunnerHandle): Promise<AgentResult> {
    const end = Date.now() + task.budget.wallclockS * 1000;
    const remaining = () => {
      const ms = end - Date.now();
      if (ms <= 0) throw new Unverified("agent deadline exceeded");
      return ms;
    };
    // Locally the agent edits the sandbox's checkout, so Ephyra can read commits and files back.
    // Orb and runner turns edit their own checkout; their outputs arrive through the transcript (and, later,
    // the ephyra_report plugin tool), so file-producing steps need the local executor today.
    const local = this.options.executor.kind === "local";
    const before = local ? await execute(runner, handle, ["git", "rev-parse", "HEAD"], remaining()) : null;
    if (before && before.exit !== 0) throw new Unverified("agent base commit");

    const threadId = await this.options.threads.get(task.trail.id);
    const run = await execute(runner, handle, ampArgs(task, this.options, threadId), remaining());
    const turn = parseAmpStream(run.stdout);
    if (!threadId) await this.options.threads.set(task.trail.id, turn.threadId);
    const transcript = `artefacts/amp/${task.step}.json`;
    const artefacts: Record<string, string> = {
      [transcript]: JSON.stringify({ threadId: turn.threadId, subtype: turn.subtype, numTurns: turn.numTurns,
        durationMs: turn.durationMs, toolUses: turn.toolUses, permissionDenials: turn.permissionDenials }, null, 2),
    };
    const usage = { tokens: turn.tokens, costMicrousd: null, model: `amp/${this.options.mode ?? "medium"}` };
    if (!turn.ok) {
      return { ok: false, artefacts, outputs: { ampThread: turn.threadId }, usage, sessions: [],
        error: `Amp turn failed (${turn.subtype}): ${turn.error}` };
    }
    if (!local) {
      if (task.step === "patch" || task.step === "repro") {
        throw new Unverified(`Amp ${this.options.executor.kind} executor for the ${task.step} step (needs the ephyra_report plugin)`);
      }
      const name = task.step === "research" ? "hypothesis.md" : task.step === "plan" ? "plan.md" : "review.json";
      return { ok: true, artefacts: { ...artefacts, [name]: turn.text }, outputs: { ampThread: turn.threadId }, usage, sessions: [] };
    }
    return this.collectLocal(task, runner, handle, before!.stdout.trim(), turn, artefacts, usage, remaining);
  }

  /** Read the step's products back from the local checkout, with the same contract as the CLI agents. */
  private async collectLocal(task: AgentTask, runner: Runner, handle: RunnerHandle, base: string, turn: AmpTurn,
    artefacts: Record<string, string>, usage: AgentResult["usage"], remaining: () => number): Promise<AgentResult> {
    const after = await execute(runner, handle, ["git", "rev-parse", "HEAD"], remaining());
    if (after.exit !== 0) throw new Unverified("agent head commit");
    const head = after.stdout.trim();
    const outputs: Record<string, string> = { ampThread: turn.threadId };
    const decode = (d: Uint8Array | null) => (d ? new TextDecoder().decode(d) : undefined);
    if (task.step === "research" || task.step === "plan") {
      const path = task.step === "research" ? "hypothesis.md" : "plan.md";
      artefacts[path] = decode(await runner.readFile(handle, path)) ?? turn.text;
    }
    if (task.step === "review") artefacts["review.json"] = turn.text;
    if (task.step === "repro") {
      const listing = await execute(runner, handle, ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", ".ephyra/repro"], remaining());
      const paths = listing.stdout.trim().split("\n").filter((p) => /^\.ephyra\/repro\/[^/]+\.sh$/.test(p));
      if (listing.exit !== 0 || paths.length !== 1) throw new Unverified("repro artefact");
      const script = decode(await runner.readFile(handle, paths[0]!));
      if (!script) throw new Unverified("repro artefact");
      artefacts[paths[0]!] = script;
      outputs.probe = paths[0]!;
    }
    if (task.step === "patch") {
      if (base === head) throw new Unverified("patch produced no commits");
      const log = await execute(runner, handle, ["git", "log", "--format=%H%x00%(trailers)%x00", `${base}..${head}`], remaining());
      const parts = log.stdout.split("\0");
      for (let i = 0; i + 1 < parts.length; i += 2) {
        if (!parts[i + 1]!.split("\n").map((l) => l.trim()).includes(`Ephyra-Trail: ${task.trail.id}`)) {
          throw new Unverified("patch trail trailer");
        }
      }
      outputs.head = head;
    }
    const sessions = await collectSessions(runner, handle, base, head, remaining());
    return { ok: true, artefacts, outputs, usage, sessions };
  }
}
