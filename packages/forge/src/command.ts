export type CommandRunner = (
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;
export const commandRunner: CommandRunner = async (args, cwd) => {
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { stdout, stderr, code };
};
import { spawn } from "node:child_process";

/** Safe default for forge transports. A timed-out write remains an unknown outcome for the adapter ledger. */
export function boundedCommandRunner(options: { deadlineMs?: number; maxOutputBytes?: number } = {}): CommandRunner {
  const deadlineMs = options.deadlineMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || !Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new TypeError("invalid forge command limits");
  }
  return async (args, cwd) => {
    if (!args.length) throw new TypeError("command required");
    const child = spawn(args[0]!, args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let bytes = 0;
    let limited = false;
    let timedOut = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const kill = () => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, deadlineMs);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) { limited = true; kill(); } else chunks.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", value => resolve(value ?? -1));
      });
      if (timedOut) throw new Error("forge command deadline exceeded");
      if (limited) throw new Error("forge command output limit exceeded");
      return { code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
    } finally { clearTimeout(timer); }
  };
}
