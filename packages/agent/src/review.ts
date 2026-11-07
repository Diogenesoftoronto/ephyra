import { ProofItem, Unverified, type AgentTask, type CodingAgent, type Runner, type RunnerHandle, type ProofItem as ProofItemType } from "@ephyra/core";

export class ReviewOutputError extends Error {
  override readonly name = "ReviewOutputError";
}

export async function reviewStep(
  agent: CodingAgent,
  task: AgentTask,
  runner: Runner,
  handle: RunnerHandle,
  base: string,
  head: string,
): Promise<Extract<ProofItemType, { kind: "bug_review" }>> {
  if (!/^[0-9a-f]{40,64}$/.test(base) || !/^[0-9a-f]{40,64}$/.test(head)) {
    throw new Error("invalid commit id");
  }
  let diff = "";
  let exit: number | undefined;
  for await (const part of runner.exec(handle, ["git", "diff", base, head], {
    deadlineMs: task.budget.wallclockS * 1000,
  })) {
    if ("chunk" in part && part.stream === "stdout") diff += part.chunk;
    if ("exit" in part) {
      if (part.timedOut) throw new Unverified("review diff deadline exceeded");
      exit = part.exit;
    }
  }
  if (exit !== 0) throw new Unverified("review diff unavailable");
  const result = await agent.run({ ...task, step: "review", untrusted: { ...task.untrusted, diff } }, runner, handle);
  if (!result.ok) throw new ReviewOutputError("review agent failed");
  try {
    const payload = JSON.parse(result.artefacts["review.json"] ?? "");
    const parsed = ProofItem.parse({ kind: "bug_review", reviewer: agent.name, findings: payload.findings });
    if (parsed.kind !== "bug_review") throw new Error("wrong kind");
    return parsed;
  } catch {
    throw new ReviewOutputError("invalid review JSON findings");
  }
}
