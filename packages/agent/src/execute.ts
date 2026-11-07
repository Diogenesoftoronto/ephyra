import { Unverified, type Runner, type RunnerHandle } from "@ephyra/core";

export async function execute(runner: Runner, handle: RunnerHandle, command: string[], deadlineMs: number, cwd?: string,
  onStdout?: (chunk: string) => void | Promise<void>) {
  let stdout = "";
  let stderr = "";
  let exit: number | undefined;
  for await (const part of runner.exec(handle, command, { deadlineMs, cwd })) {
    if ("chunk" in part) {
      if (part.stream === "stdout") { stdout += part.chunk; await onStdout?.(part.chunk); }
      else stderr += part.chunk;
    } else {
      if (part.timedOut) throw new Unverified("command deadline exceeded");
      exit = part.exit;
    }
  }
  if (exit === undefined) throw new Unverified("command exit status");
  return { stdout, stderr, exit };
}
