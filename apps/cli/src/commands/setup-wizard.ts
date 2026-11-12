import type { AccountSettings, RepositoryUpdate, SetupMode, SetupRun } from "@ephyra/core";
import type { Credentials, LoginIo } from "../login";
import { login } from "../login";
import { oneLine } from "../inbox/text";
import { plain } from "../inbox/view";
import { type RepositoryDiscovery, discoverRepository } from "./discovery";
import { type WizardUi, CliCancelledError, loginPresentation, pause } from "./interactive";
import { CliSetupClient, SetupWriteUnknown } from "./setup-client";
import { type SetupReceipts, setupReceipts } from "./setup-receipt";
import { setupView } from "./views";

export function serverAddressError(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
      return "Use the server's base address without a path, credentials, query or fragment.";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      return "Use HTTPS, or HTTP for a local server.";
  } catch { return "Enter a server address such as https://console.ephyra.quest."; }
}

export function repositoryAddressError(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || !url.pathname.replace(/\//g, ""))
      return "Enter the repository's HTTPS address.";
    if (url.username || url.password || url.search || url.hash)
      return "Use an address without credentials, query or fragment. Access tokens are entered separately.";
    if (/[\s\x00-\x1f\x7f]/.test(value)) return "Use an HTTPS address without whitespace or control characters.";
  } catch { return "Enter the repository's HTTPS address."; }
}

const sameRepo = (a: string, b: string) => a.replace(/\/$/, "").replace(/\.git$/, "") === b.replace(/\/$/, "").replace(/\.git$/, "");

export interface WizardApi {
  settings(refreshRepository?: boolean): Promise<AccountSettings>;
  saveRepository(input: RepositoryUpdate, key: string): Promise<AccountSettings>;
  detectedTelemetry(): Promise<string[]>;
  current(key?: string): Promise<SetupRun | null>;
  start(mode: SetupMode, key: string): Promise<SetupRun>;
}
export type WizardOptions = {
  cwd: string; creds: Credentials | null; url?: string; io: LoginIo; ui: WizardUi; signal: AbortSignal;
  /** Test seams: production uses local discovery, owner-scoped HTTP and private receipt files. */
  discover?: (cwd: string) => Promise<RepositoryDiscovery>;
  api?: WizardApi; receipts?: SetupReceipts; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  followMs?: number;
};

export function connectionSummary(settings: AccountSettings, detected: readonly string[]) {
  const lines = [`Repository hints: ${detected.length ? detected.join(", ") : "none found"}.`];
  lines.push(`Model access: ${settings.model.status.replace(/_/g, " ")}.`);
  if (settings.telemetry?.enabled) lines.push(`PostHog: ${settings.telemetry.status}.`);
  for (const source of settings.telemetrySources ?? [])
    if (source.workspaceId === settings.workspaceId) lines.push(`${source.provider}: ${source.enabled ? source.status : "disabled"}.`);
  if (settings.knowledge?.enabled) lines.push("Knowledge: connected; permissions are checked when used.");
  if (settings.automation) lines.push(`Execution: ${settings.automation.configured ? "configured" : "not configured"}.`);
  lines.push("Repository hints do not verify a connection. Setup records what it can actually observe.");
  return lines.join("\n");
}

/** Only report changed server state; queued and running are never relabelled as complete. */
export async function followSetup(api: Pick<WizardApi, "current">, initial: SetupRun, options: {
  signal: AbortSignal; update: (run: SetupRun) => void; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; timeoutMs?: number;
}): Promise<SetupRun> {
  const end = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  let run = initial;
  let previous = "";
  for (;;) {
    options.signal.throwIfAborted();
    const signature = JSON.stringify([run.id, run.status, run.steps, run.blockers, run.bootstrap, run.investigationActive]);
    if (signature !== previous) { options.update(run); previous = signature; }
    if (!["queued", "running"].includes(run.status) || Date.now() >= end) return run;
    await (options.sleep ?? pause)(2000, options.signal);
    const next = await api.current(run.operationKey);
    if (!next || next.id !== initial.id) throw new Error("The recorded setup changed. Resume the wizard to inspect it; no new run was started.");
    run = next;
  }
}

export async function setupWizard(options: WizardOptions): Promise<SetupRun | null> {
  const { ui, signal } = options;
  ui.intro("Set up Ephyra");
  const local = await (options.discover ?? discoverRepository)(options.cwd);
  ui.note([
    local.root ? `Repository: ${oneLine(local.root)}` : "No local git repository found. You can connect one by address.",
    ...(local.remote ? [`Remote: ${local.remote}`] : []),
    ...(local.branch ? [`Branch hint: ${local.branch} (setup can discover the remote default)`] : []),
    `Framework hints: ${local.frameworks.join(", ") || "none found"}`,
    `Integration hints: ${local.integrations.join(", ") || "none found"}`,
    ...local.warnings,
  ].join("\n"), "Found in this checkout");
  let creds = options.creds;
  let origin = options.url ?? creds?.url;
  if (!origin || serverAddressError(origin))
    origin = await ui.text("Ephyra server", "https://console.ephyra.quest", serverAddressError);
  origin = new URL(origin).origin;
  if (!creds || creds.url !== origin) {
    ui.note("Approve the browser request only when its code matches the code shown here.", "Sign in");
    creds = await login(origin, { ...options.io, ...loginPresentation(ui), signal });
  }
  const api = options.api ?? new CliSetupClient(origin, creds.token, creds.did, options.io.fetch, signal);
  const receipts = options.receipts ?? setupReceipts(origin, creds.did, options.io.env);
  const consoleUrl = `${origin}/app/#/onboarding`;
  const openConsole = async () => {
    try { await options.io.open?.(consoleUrl); }
    catch { ui.warn("The browser could not be opened. Open the console link above to continue."); }
  };
  let settings = await ui.work("Reading saved settings…", () => api.settings());
  const pending = await receipts.read();
  let resumed: SetupRun | null = null;
  if (pending?.kind === "repository") {
    throw new Error(`A repository change is still unconfirmed. Inspect ${consoleUrl} and ask the operator to reconcile ${pending.key}. No write was retried.`);
  }
  if (pending?.kind === "setup") {
    if (settings.workspaceId !== pending.workspace)
      throw new Error(`The workspace changed while setup was unconfirmed. Ask the operator to reconcile ${pending.key}. No new run was started.`);
    resumed = await api.current(pending.key);
    if (resumed?.operationKey !== pending.key) throw new SetupWriteUnknown(pending.key);
    await receipts.clear(pending.key);
  }
  if (!resumed) {
    const repository = settings.repository;
    const choice = await ui.select("Repository for this workspace", [
      ...(repository ? [{ value: "saved", label: `Use ${oneLine(repository.url)}`, hint: `Saved branch: ${oneLine(repository.branch)}` }] : []),
      ...(local.remote && !repositoryAddressError(local.remote) && (!repository || !sameRepo(repository.url, local.remote))
        ? [{ value: "local", label: "Connect this checkout's remote", hint: oneLine(local.remote) }] : []),
      { value: "manual", label: "Enter a repository address" },
      { value: "browser", label: "Connect through the browser", hint: "GitHub App, forge sign-in or existing console settings" },
    ]);
    if (choice === "browser") {
      ui.note(consoleUrl, "Connect a repository in the console");
      await openConsole();
      if (!await ui.confirm("Read the saved connection when you're ready?", "Read connection", "Stop here")) throw new CliCancelledError();
      settings = await api.settings(true);
      if (!settings.repository) throw new Error(`No repository is saved yet. Connect one at ${consoleUrl}, then resume the wizard.`);
    } else if (choice !== "saved") {
      const url = choice === "local" ? local.remote! : await ui.text("Repository HTTPS address", "", repositoryAddressError);
      const branch = await ui.text("Branch to watch (leave blank to discover the remote default)", "", value =>
        value.length > 200 || /[\s\x00-\x1f\x7f]/.test(value) ? "Enter a branch name without whitespace, or leave blank." : undefined);
      const access = await ui.select("Repository access", [
        { value: "public", label: "Public repository", hint: "No access token" },
        { value: "token", label: "Use an access token", hint: "Masked here; stored encrypted by the server" },
      ]);
      let token: string | undefined;
      let username: string | undefined;
      if (access === "token") {
        token = (await ui.password("Repository access token")).trim();
        if (!token || /[\r\n\0]/.test(token) || token.length > 8192) throw new Error("Enter a nonempty repository token without line breaks.");
        username = await ui.text("Git username (leave blank for the provider default)");
      }
      ui.note(`${url}\nBranch: ${branch || "discover remote default"}\n${repository
        ? "Replacing the repository can remove this workspace's integration connections."
        : "Ephyra will verify repository access. Local files and git settings stay as they are."}`, "Connect repository");
      if (!await ui.confirm("Save this repository connection?", "Save connection", "Stop here")) throw new CliCancelledError();
      const key = `setup:${crypto.randomUUID()}`;
      await receipts.claim({ kind: "repository", key, workspace: settings.workspaceId, version: settings.version, url, branch: branch || null });
      try {
        settings = await ui.work("Verifying repository access…", () => api.saveRepository({
          expectedVersion: settings.version, url, branch: branch || "main", ...(!branch ? { discoverDefaultBranch: true } : {}),
          ...(token ? { token, ...(username ? { username } : {}) } : { clearToken: true }),
        }, key));
        await receipts.clear(key);
      } catch (error) {
        if (!(error instanceof SetupWriteUnknown)) await receipts.clear(key);
        throw error;
      } finally { token = undefined; }
    }

    let detected = [...local.integrations];
    try { detected = [...new Set([...detected, ...await api.detectedTelemetry()])]; }
    catch (error) {
      signal.throwIfAborted();
      ui.warn(`Remote integration discovery is unavailable. ${error instanceof Error ? error.message : "Resume to try again."}`);
    }
    ui.note(connectionSummary(settings, detected), "Connections");
    if (await ui.select("Configure model access and integrations", [
      { value: "continue", label: "Continue with saved connections", hint: "Setup will record any missing capabilities" },
      { value: "browser", label: "Connect integrations in the browser", hint: "PostHog, Sentry, mobile logs, OTLP, knowledge and model access" },
    ]) === "browser") {
      ui.note(consoleUrl, "Connection settings");
      await openConsole();
      if (!await ui.confirm("Read the saved connections when you're ready?", "Read connections", "Stop here")) throw new CliCancelledError();
      const refreshed = await api.settings();
      if (refreshed.workspaceId !== settings.workspaceId)
        throw new Error("The repository workspace changed in the console. Resume the wizard to inspect the new workspace.");
      settings = refreshed;
      ui.note(connectionSummary(settings, detected), "Saved connections");
    }
    resumed = await api.current();
    const recheck = resumed && !["queued", "running"].includes(resumed.status)
      ? await ui.select(`Recorded setup is ${resumed.status}`, [
        { value: "show", label: "Show saved progress", hint: "No new setup run" },
        { value: "recheck", label: "Recheck setup", hint: "Start a new recorded run using the saved connections" },
      ]) === "recheck"
      : false;
    if (!resumed || recheck) {
      const mode = await ui.select("How should Ephyra work?", [
        { value: "autonomous", label: "Self-driving", hint: "Work within your configured policy; ask when something needs you" },
        { value: "supervised", label: "Supervised", hint: "Pause for your review at configured checkpoints" },
      ]) as SetupMode;
      ui.note([
        "Setup reads the connected repository, prepares policy and checks available capabilities.",
        "It may use configured model and compute services within existing permissions and budgets.",
      ].join("\n"), "Start recorded setup");
      if (!await ui.confirm("Start setup for this repository?", "Start setup", "Stop here")) throw new CliCancelledError();
      const key = `setup:${crypto.randomUUID()}`;
      await receipts.claim({ kind: "setup", key, workspace: settings.workspaceId });
      try {
        resumed = await ui.work("Starting recorded setup…", () => api.start(mode, key));
        await receipts.clear(key);
      } catch (error) {
        if (!(error instanceof SetupWriteUnknown)) await receipts.clear(key);
        throw error;
      }
    }
  }
  ui.note("Only recorded server updates appear below. Ctrl+C stops waiting; server work continues.", "Follow setup");
  const run = await followSetup(api, resumed, {
    signal, sleep: options.sleep, timeoutMs: options.followMs,
    update: value => ui.note(plain(setupView(value, Math.min(process.stdout.columns || 100, 110))), "Recorded progress"),
  });
  if (run.status === "ready") ui.outro("Setup is ready. Use `ephyra inbox` for requests and `ephyra activity` to follow work.");
  else if (run.status === "queued" || run.status === "running")
    ui.outro("Setup is still running on the server. Resume with `ephyra setup --interactive` or read `ephyra setup`.");
  else ui.outro(`Setup is ${run.status}. Follow the recorded next steps above, or open ${consoleUrl}.`);
  return run;
}
