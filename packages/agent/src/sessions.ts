import { Unverified, type AgentResult, type Runner, type RunnerHandle } from "@ephyra/core";
import { execute } from "./execute";

export async function collectSessions(
  runner: Runner, handle: RunnerHandle, base: string, head: string, deadlineMs: number,
): Promise<AgentResult["sessions"]> {
  if (!/^[0-9a-f]{40,64}$/.test(base) || !/^[0-9a-f]{40,64}$/.test(head)) throw new Error("invalid commit id");
  const result = await execute(runner, handle, ["git", "log", "--format=%(trailers)", `${base}..${head}`], deadlineMs);
  if (result.exit !== 0) throw new Unverified("checkpoint trailers");
  return [...result.stdout.matchAll(/^Entire-Checkpoint:\s*(\S+)\s*$/gim)]
    .map(match => ({ provider: "entire" as const, checkpoint: match[1]! }));
}
