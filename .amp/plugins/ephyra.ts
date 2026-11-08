import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const description = "Report actual Ephyra repro and patch artifacts from an authenticated Amp executor.";

// Structural subset of the installed `amp plugins show-docs` API. No runtime SDK dependency is required.
type PluginAPI = {
  on(event: string, handler: (event: any, context: any) => any): unknown;
  registerTool(tool: { name: string; description: string; inputSchema: Record<string, unknown>;
    execute(input: Record<string, unknown>, context: { thread: { id: string } }): Promise<string> }): unknown;
  helpers: { shellCommandFromToolCall(event: any): { command: string; dir?: string } | null;
    filesModifiedByToolCall(event: any): { toString(): string }[] | null; filePathFromURI(uri: { toString(): string }): string };
};
type Request = { schema: 1; nonce: string; trailId: string; revision: number; step: "repro" | "patch"; base: string;
  expectedThread: string | null; expiresAt: string; url: string };
type State = { request: Request; policies: { decision: "allow" | "reject"; rule: string; reason: string; tool: string; callId: string }[];
  reported: boolean; uncertain: boolean; reminded: boolean };
type Run = (argv: string[], cwd: string, maxBytes?: number) => Promise<Uint8Array>;
export type EphyraPluginOptions = { origin?: string; cwd?: string; run?: Run; fetcher?: typeof fetch; now?: () => number;
  identity?: (audience: string, threadId: string) => Promise<string> };
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const MAX_BUNDLE = 8 * 1024 * 1024;
const MAX_OUTPUT = 12 * 1024 * 1024;

async function boundedRun(argv: string[], cwd: string, limit = MAX_OUTPUT): Promise<Uint8Array> {
  const process = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let size = 0;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > limit) { process.kill(); throw new Error("Command output exceeds the report bound."); }
        chunks.push(result.value);
      }
      return new Uint8Array(Buffer.concat(chunks));
    } finally { reader.releaseLock(); }
  };
  const timer = setTimeout(() => process.kill(), 15_000);
  try {
    const [out, , exit] = await Promise.all([read(process.stdout), read(process.stderr), process.exited]);
    if (exit !== 0) throw new Error("The fixed report command did not complete successfully.");
    return out;
  } finally { clearTimeout(timer); }
}

function requestFrom(message: string, origin: string | undefined, thread: string, now: number): Request | null {
  const matches = [...message.matchAll(/<ephyra_report_request>([^<]+)<\/ephyra_report_request>/g)];
  if (matches.length !== 1 || !origin) return null;
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password) return null;
  try {
    const r = JSON.parse(matches[0]![1]!) as Request;
    if (r.schema !== 1 || !/^[a-f0-9]{64}$/.test(r.nonce) || !/^[a-f0-9-]{36}$/.test(r.trailId)
      || !Number.isInteger(r.revision) || r.revision < 1 || !["repro", "patch"].includes(r.step)
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(r.base) || r.expectedThread !== null && r.expectedThread !== thread
      || !Number.isFinite(Date.parse(r.expiresAt)) || Date.parse(r.expiresAt) <= now || Date.parse(r.expiresAt) > now + 86_400_000
      || r.url !== `${origin}/amp/reports/${r.nonce}`) return null;
    return r;
  } catch { return null; }
}

function blockedPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part === ".." || part === ".git" || part === ".amp"
    || /^\.env(?:\.|$)/i.test(part) || /^(?:id_rsa|id_ed25519|credentials|secrets)(?:\.|$)/i.test(part));
}

/** Install this file into the remote project's .amp/plugins; set only the public EPHYRA_AMP_REPORT_ORIGIN there. */
export function installEphyraPlugin(amp: PluginAPI, options: EphyraPluginOptions = {}): void {
  const states = new Map<string, State>();
  const run = options.run ?? boundedRun;
  const cwd = options.cwd ?? process.cwd();
  const origin = options.origin ?? process.env.EPHYRA_AMP_REPORT_ORIGIN;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const stateFor = (thread: string) => {
    const state = states.get(thread);
    if (!state || Date.parse(state.request.expiresAt) <= now()) throw new Error("A current Ephyra report request is required.");
    return state;
  };
  const repository = async () => text(await run(["git", "rev-parse", "--show-toplevel"], cwd, 4000)).trim();
  const file = async (root: string, path: string, maximum: number): Promise<Uint8Array> => {
    if (isAbsolute(path) || blockedPath(path)) throw new Error("The report path is outside the permitted repository files.");
    const absolute = await realpath(resolve(root, path));
    const local = relative(await realpath(root), absolute);
    if (!local || local.startsWith(`..${sep}`) || isAbsolute(local) || blockedPath(local)) throw new Error("The report path escapes the repository.");
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.size > maximum) throw new Error("The report file is unavailable or too large.");
    const bytes = new Uint8Array(await readFile(absolute));
    if (bytes.byteLength > maximum) throw new Error("The report file exceeds its bound.");
    return bytes;
  };

  amp.on("agent.start", (event) => {
    const request = requestFrom(event.message, origin, event.thread.id, now());
    if (!request) { states.delete(event.thread.id); return; }
    const existing = states.get(event.thread.id);
    if (existing?.request.nonce !== request.nonce) states.set(event.thread.id, { request, policies: [], reported: false, uncertain: false, reminded: false });
    return { message: { display: false, content: "This Ephyra turn must end with ephyra_report. Use ephyra_commit for a patch commit. "
      + "Reported files and Git objects are read by the plugin; prose is never a completed artifact. Shell commands and protected files are restricted." } };
  });

  amp.on("tool.call", (event) => {
    const state = states.get(event.thread.id);
    if (!state) return { action: "allow" };
    const shell = amp.helpers.shellCommandFromToolCall(event);
    const paths = amp.helpers.filesModifiedByToolCall(event)?.map((uri) => amp.helpers.filePathFromURI(uri)) ?? [];
    for (const field of ["path", "file", "file_path"]) if (typeof event.input?.[field] === "string") paths.push(event.input[field]);
    const unsafePath = paths.some((path) => blockedPath(path) || isAbsolute(path) && (relative(cwd, path).startsWith("..") || !relative(cwd, path)));
    // This is a conservative tool gate, not a replacement for the host's isolated service profile.
    const shellAllowed = !shell || /^git (?:status|diff|log|show|rev-parse)(?: [\w./:@=-]+)*$/.test(shell.command)
      && !shell.command.includes("--output") && !shell.command.includes("--ext-diff") && (!shell.dir || resolve(shell.dir) === resolve(cwd));
    const reject = unsafePath || !shellAllowed;
    const reason = unsafePath ? "Protected or external repository path." : !shellAllowed
      ? "Use repository edit tools and ephyra_commit; arbitrary shell execution needs a separate host-granted tool." : "Repository tool permitted.";
    if (state.policies.length < 100) state.policies.push({ decision: reject ? "reject" : "allow", rule: "ephyra-repository-tools",
      reason, tool: String(event.tool).slice(0, 100), callId: String(event.toolUseID).slice(0, 100) });
    return reject ? { action: "reject-and-continue", message: reason } : { action: "allow" };
  });

  amp.registerTool({
    name: "ephyra_commit", description: "Commit selected existing repository files for the current Ephyra patch with its required trail trailer.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 } }, required: ["paths"], additionalProperties: false },
    async execute(input, context) {
      const state = stateFor(context.thread.id);
      if (state.request.step !== "patch" || !Array.isArray(input.paths) || !input.paths.length || input.paths.length > 100)
        throw new Error("A patch and selected existing files are required.");
      const root = await repository();
      for (const path of input.paths) {
        if (typeof path !== "string" || path.startsWith(".ephyra/")) throw new Error("Invalid patch file.");
        await file(root, path, MAX_BUNDLE);
      }
      if (text(await run(["git", "diff", "--cached", "--name-only"], root)).trim()) throw new Error("Unrelated staged changes must be resolved first.");
      await run(["git", "add", "--", ...input.paths], root);
      await run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Ephyra", "-c", "user.email=agent@ephyra.invalid",
        "commit", "-m", `fix: Ephyra trail ${state.request.trailId}`, "-m", `Ephyra-Trail: ${state.request.trailId}`], root);
      return text(await run(["git", "rev-parse", "HEAD"], root, 1000)).trim();
    },
  });

  amp.registerTool({
    name: "ephyra_report", description: "Read and submit the actual repro script or patch bundle for this Ephyra step. No artifact text is accepted as an argument.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, context) {
      const state = stateFor(context.thread.id);
      if (state.reported) return "The exact artifact report was acknowledged.";
      if (state.uncertain) throw new Error("Report delivery is uncertain. Reconcile the existing operation; it will not be resent.");
      const root = await repository();
      const head = text(await run(["git", "rev-parse", "HEAD"], root, 1000)).trim();
      const report: Record<string, unknown> = { schema: 1, request: state.request, threadId: context.thread.id, policies: state.policies };
      if (state.request.step === "repro") {
        if (head !== state.request.base) throw new Error("The repro checkout does not match the assigned commit.");
        const listing = text(await run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", ".ephyra/repro"], root, 4000));
        const paths = listing.trim().split("\n").filter((path) => /^\.ephyra\/repro\/[\w.-]+\.sh$/.test(path));
        if (paths.length !== 1) throw new Error("Exactly one repro script is required.");
        report.probe = { path: paths[0], content: text(await file(root, paths[0]!, 256_000)) };
      } else {
        if (head === state.request.base) throw new Error("The patch produced no commit.");
        await run(["git", "merge-base", "--is-ancestor", state.request.base, head], root, 1000);
        const messages = text(await run(["git", "log", "--format=%H%x00%(trailers)%x00", `${state.request.base}..${head}`], root));
        const parts = messages.trim().split("\0");
        for (let i = 0; i + 1 < parts.length; i += 2) if (!parts[i + 1]!.split("\n").map((line) => line.trim()).includes(`Ephyra-Trail: ${state.request.trailId}`))
          throw new Error("A patch commit is missing its trail trailer.");
        const temporary = await mkdtemp(join(tmpdir(), "ephyra-amp-report-"));
        try {
          const bundlePath = join(temporary, "patch.bundle");
          await run(["git", "bundle", "create", bundlePath, "HEAD", `^${state.request.base}`], root);
          const stat = await lstat(bundlePath);
          if (stat.size > MAX_BUNDLE) throw new Error("The patch bundle exceeds its limit.");
          const bytes = new Uint8Array(await readFile(bundlePath));
          report.patch = { head, bundle: Buffer.from(bytes).toString("base64"), digest: digest(bytes) };
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
      // Token never enters model context, report bytes, journal artifacts or plugin logs.
      let identityCommand = ["amp", "orb", "id-token", "--audience", origin!];
      if (process.env.EPHYRA_AMP_REPORT_IDENTITY_COMMAND) {
        const configured: unknown = JSON.parse(process.env.EPHYRA_AMP_REPORT_IDENTITY_COMMAND);
        if (!Array.isArray(configured) || !configured.length || configured.length > 20
          || !configured.every((arg) => typeof arg === "string" && arg.length > 0 && arg.length <= 2000 && !arg.includes("\0")))
          throw new Error("The host identity command is invalid.");
        identityCommand = configured.map((arg: string) => arg.replaceAll("{audience}", origin!).replaceAll("{threadId}", context.thread.id));
      }
      const token = (options.identity ? await options.identity(origin!, context.thread.id)
        : text(await run(identityCommand, root, 20_000))).trim();
      if (!token || token.length > 20_000) throw new Error("The executor could not authenticate this report.");
      state.uncertain = true;
      const body = JSON.stringify(report);
      if (Buffer.byteLength(body) > MAX_OUTPUT) throw new Error("The report exceeds its transport limit.");
      const response = await fetcher(state.request.url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("The report was not acknowledged; inspect its existing operation.");
      const receipt = await response.json() as { digest?: string };
      if (receipt.digest !== digest(body)) throw new Error("The report acknowledgment does not match its exact bytes.");
      state.reported = true;
      state.uncertain = false;
      return "The actual artifact report was acknowledged. This is not proof that the repair passed.";
    },
  });

  amp.on("agent.end", (event) => {
    const state = states.get(event.thread.id);
    if (!state || state.reported || state.uncertain || state.reminded || event.status !== "done") return;
    state.reminded = true;
    return { action: "continue", userMessage: "Complete this assigned step with ephyra_report. Do not claim success without its acknowledgment.\n"
      + `<ephyra_report_request>${JSON.stringify(state.request)}</ephyra_report_request>` };
  });
}

export default installEphyraPlugin;
