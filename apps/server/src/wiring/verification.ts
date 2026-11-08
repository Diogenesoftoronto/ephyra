import { z } from "zod";
import { ProofItem, Unverified, sha256Hex, type ProofItem as Item } from "@ephyra/core";
import { redact, type ProofEvidenceCollector, type ProofEvidenceContext } from "@ephyra/agent";
import { executeProbe, type GitProbeCatalog, type ProbeDefinition, type ProbeReceipt } from "./probes.ts";

export type BoundProofEvidence = {
  trailId: string; rev: number; base: string; head: string;
  /** Actual source receipt, such as a recorded provider operation or command report. Never generated from model prose. */
  operationKey: string; source: string; items: Item[];
};
export type VerificationCommand = {
  id: string; command: string[];
  /** Command collectors can produce UI/replay reports. Human/persona provenance needs the host-authorized sources port. */
  kinds: Array<"story_render" | "story_interaction" | "story_visual_diff" | "traffic_replay"
    | "recording" | "terminal_recording">;
};
export type VerificationOptions = {
  catalog: Pick<GitProbeCatalog, "list">;
  review?: (context: ProofEvidenceContext) => Promise<Extract<Item, { kind: "bug_review" }>>;
  commands?: VerificationCommand[] | ((context: ProofEvidenceContext) => Promise<VerificationCommand[]>);
  /** The hosting integration checks grants/current authority before returning any external study or approval. */
  sources?: (context: ProofEvidenceContext) => Promise<BoundProofEvidence[]>;
  onReceipts?: (context: ProofEvidenceContext, receipts: Array<ProbeReceipt | BoundProofEvidence>) => Promise<void>;
  secrets?: string[];
};
const BASIC = new Set(["repro_before", "repro_after", "tests", "diff_scope"]);
const Report = z.object({ schema: z.literal(1), trailId: z.string(), rev: z.number().int().positive(),
  base: z.string(), head: z.string(), items: z.array(ProofItem).min(1).max(100) });
const MAX_OUTPUT = 256_000;

async function currentRegression(context: ProofEvidenceContext): Promise<ProbeDefinition | null> {
  const before = context.items.find(item => item.kind === "repro_before");
  const after = context.items.find(item => item.kind === "repro_after");
  if (!before || !after) return null;
  if (before.probe !== after.probe || !/^\.ephyra\/repro\/[\w.-]+\.sh$/.test(after.probe)) {
    throw new Unverified("current regression repro binding");
  }
  const bytes = await context.runner.readFile(context.handle, after.probe);
  if (!bytes?.length || bytes.byteLength > MAX_OUTPUT) throw new Unverified("current regression script");
  const script = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { id: `regression:current:${context.trail.id}:${context.trail.rev}`, kind: "regression", paths: [], script,
    source: { commit: context.head, path: after.probe, digest: `sha256:${sha256Hex(JSON.stringify(script))}` } };
}

function assertBound(receipt: Pick<BoundProofEvidence, "trailId" | "rev" | "base" | "head">, context: ProofEvidenceContext) {
  if (receipt.trailId !== context.trail.id || receipt.rev !== context.trail.rev
    || receipt.base !== context.base || receipt.head !== context.head) throw new Unverified("proof source exact revision binding");
}

function safeItem(raw: Item, secrets?: string[]): Item {
  const item = ProofItem.parse(raw);
  if (BASIC.has(item.kind)) throw new Unverified("source cannot replace core proof observations");
  const encoded = JSON.stringify(item);
  if (Buffer.byteLength(encoded) > MAX_OUTPUT) throw new Unverified("bounded proof source item");
  return ProofItem.parse(JSON.parse(redact(encoded, secrets, MAX_OUTPUT)));
}

/** A report is accepted only after its actual configured command exits normally at the exact prepared head. */
export async function runVerificationCommand(context: ProofEvidenceContext, command: VerificationCommand): Promise<BoundProofEvidence> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(command.id) || !command.command.length || command.command.length > 100
    || command.command.some(arg => typeof arg !== "string" || !arg || arg.length > 4000 || arg.includes("\0"))
    || !command.kinds.length || command.kinds.some(kind => ![
      "story_render", "story_interaction", "story_visual_diff", "traffic_replay", "recording", "terminal_recording",
    ].includes(kind))) throw new Unverified("verification command configuration");
  let stdout = "", stderr = "", exit: number | undefined;
  for await (const part of context.runner.exec(context.handle, command.command, {
    cwd: context.headCwd, deadlineMs: context.remainingMs(),
  })) {
    if ("chunk" in part) {
      if (part.stream === "stdout") stdout += part.chunk;
      else stderr += part.chunk;
      if (stdout.length + stderr.length > MAX_OUTPUT) throw new Unverified("verification command output bound");
    } else {
      if (exit !== undefined || part.timedOut) throw new Unverified("verification command complete receipt");
      exit = part.exit;
    }
  }
  context.remainingMs();
  if (exit !== 0) throw new Unverified("verification command did not pass");
  let report: z.infer<typeof Report>;
  try { report = Report.parse(JSON.parse(stdout)); }
  catch { throw new Unverified("verification report schema"); }
  assertBound(report, context);
  if (report.items.some(item => !command.kinds.includes(item.kind as VerificationCommand["kinds"][number]))) {
    throw new Unverified("verification command emitted an unauthorized evidence kind");
  }
  return { ...report, operationKey: `proof:${context.trail.id}:${context.trail.rev}:${command.id}`, source: `command:${command.id}` };
}

/** Empty or absent configuration stays missing in the policy result; it never creates a passing empty proof item. */
export function createVerificationCollector(options: VerificationOptions): ProofEvidenceCollector {
  return async context => {
    const items: Item[] = [];
    const receipts: Array<ProbeReceipt | BoundProofEvidence> = [];
    const probes = [...await options.catalog.list(context.trail)];
    // A first repair has no historical registry yet. Execute its newly proved repro again as the first regression;
    // merely listing the earlier repro result would not establish a separate regression execution.
    const current = await currentRegression(context);
    if (current) probes.unshift(current);
    for (const kind of ["regression", "intent"] as const) {
      const applicable = probes.filter(probe => probe.kind === kind);
      if (!applicable.length) continue;
      const ran: string[] = [], failed: string[] = [];
      for (const probe of applicable) {
        const receipt = await executeProbe(probe, { runner: context.runner, handle: context.handle,
          cwd: context.headCwd, remainingMs: context.remainingMs, secrets: options.secrets });
        receipts.push(receipt);
        ran.push(probe.id);
        if (receipt.result === "fail") failed.push(probe.id);
      }
      items.push({ kind: kind === "regression" ? "regression_probes" : "intent_probes", ran, failed });
    }
    if (options.review) {
      const item = safeItem(await options.review(context), options.secrets);
      if (item.kind !== "bug_review" || !item.reviewer.trim()) throw new Unverified("actual review identity");
      items.push(item);
    }
    const commands = typeof options.commands === "function" ? await options.commands(context) : options.commands ?? [];
    if (commands.length > 30 || new Set(commands.map(command => command.id)).size !== commands.length) {
      throw new Unverified("verification command count and identities");
    }
    for (const command of commands) {
      const receipt = await runVerificationCommand(context, command);
      receipts.push(receipt);
      items.push(...receipt.items.map(item => safeItem(item, options.secrets)));
    }
    const sources = await options.sources?.(context) ?? [];
    if (sources.length > 30) throw new Unverified("external proof source bound");
    for (const source of sources) {
      assertBound(source, context);
      if (!source.operationKey?.trim() || !source.source?.trim() || !source.items.length || source.items.length > 100) {
        throw new Unverified("external proof source receipt");
      }
      const sanitized = { ...source, items: source.items.map(item => safeItem(item, options.secrets)) };
      receipts.push(sanitized);
      items.push(...sanitized.items);
    }
    context.remainingMs();
    await options.onReceipts?.(context, receipts);
    return items;
  };
}
