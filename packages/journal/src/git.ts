export class GitError extends Error {
  constructor(
    public readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}
export async function run(
  args: string[],
  opts: {
    gitDir?: string;
    cwd?: string;
    input?: string | Uint8Array;
    env?: Record<string, string>;
  } = {},
) {
  const proc = Bun.spawn(
    ["git", ...(opts.gitDir ? [`--git-dir=${opts.gitDir}`] : []), ...args],
    {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (opts.input !== undefined) proc.stdin.write(opts.input);
  proc.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    bytes: new Uint8Array(out),
    text: new TextDecoder().decode(out).trimEnd(),
    err,
    code,
  };
}
export async function must(
  args: string[],
  opts: Parameters<typeof run>[1] = {},
) {
  const r = await run(args, opts);
  if (r.code) throw new GitError(args[0] ?? "git", r.err.trim());
  return r;
}
