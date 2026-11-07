export type CommandRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export const commandRunner: CommandRunner = async (args, cwd) => {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};
