import { expect, test } from "bun:test";
import fc from "fast-check";
import type { AccountSettings, SetupRun } from "@ephyra/core";
import { followSetup, repositoryAddressError, serverAddressError, setupWizard, type WizardApi } from "../src/commands/setup-wizard";
import { canPrompt, CliCancelledError, pause, withCliSignal, type WizardUi } from "../src/commands/interactive";
import { SetupWriteUnknown } from "../src/commands/setup-client";
import type { SetupPending, SetupReceipts } from "../src/commands/setup-receipt";

const settings = (): AccountSettings => ({
  did: "did:plc:owner", version: 1, workspaceId: "ws-before", repository: null,
  model: { provider: "none", model: "", baseUrl: null, keyConfigured: false, status: "not_configured", checkedAt: null, detail: null },
  onboarding: { status: "new", updatedAt: "2026-11-12T00:00:00Z" }, execution: "not_configured",
});
const repository = { url: "https://git.example/team/app.git", branch: "trunk", head: "a".repeat(40),
  verifiedAt: "2026-11-12T00:00:00Z", credentialConfigured: false };
const run = (status: SetupRun["status"] = "ready", key = "setup:00000000-0000-4000-8000-000000000000"): SetupRun => ({
  id: "a".repeat(32), operationKey: key, mode: "autonomous", status, repository,
  startedAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z",
  steps: [{ id: "repo", name: "Read repository", status: status === "ready" ? "complete" : "running", detail: "Recorded by fixture server" }],
  artifacts: [], blockers: status === "blocked" ? [{ id: "runner", summary: "Runner unavailable", action: "Connect a runner", owner: "operator" }] : [],
});

function harness(answers: (string | boolean)[], initial = settings()) {
  let account = initial;
  let record: SetupRun | null = null;
  let pending: SetupPending | null = null;
  const messages: string[] = [];
  const calls: { action: string; value?: unknown }[] = [];
  const controller = new AbortController();
  const next = () => { if (!answers.length) throw new Error("Unexpected prompt"); return answers.shift()!; };
  const ui: WizardUi = {
    intro: s => messages.push(s), outro: s => messages.push(s), note: (s, title) => messages.push(`${title}\n${s}`), warn: s => messages.push(s),
    text: async (_s, _i, validate) => { const value = String(next()); expect(validate?.(value)).toBeUndefined(); return value; },
    password: async () => String(next()), select: async (_s, choices) => {
      const value = String(next()); expect(choices.map(c => c.value)).toContain(value); return value;
    },
    confirm: async () => Boolean(next()), work: async (_message, task) => task(),
  };
  const api: WizardApi = {
    settings: async refresh => { calls.push({ action: "settings", value: refresh }); return account; },
    saveRepository: async (input, key) => {
      calls.push({ action: "repository", value: { input, key } });
      expect(pending?.key).toBe(key); // persisted before dispatch
      account = { ...account, version: 2, workspaceId: "ws-after", repository };
      return account;
    },
    detectedTelemetry: async () => ["sentry"],
    current: async key => { calls.push({ action: "current", value: key }); return record; },
    start: async (mode, key) => {
      calls.push({ action: "start", value: { mode, key } });
      expect(pending).toMatchObject({ key, kind: "setup", workspace: "ws-after" });
      record = { ...run("ready", key), mode }; return record;
    },
  };
  const receipts: SetupReceipts = {
    read: async () => pending,
    claim: async value => { expect(pending).toBeNull(); pending = value; },
    clear: async key => { expect(pending?.key).toBe(key); pending = null; },
  };
  const options = {
    cwd: "/fixture", creds: { url: "https://ephyra.example", token: "session-canary", did: account.did },
    ui, api, receipts, signal: controller.signal,
    io: { print: (s: string) => messages.push(s), open: (url: string) => { calls.push({ action: "open", value: url }); },
      fetch: (async () => { throw new Error("No network"); }) as unknown as typeof fetch, env: {}, sleep: async () => {} },
    discover: async () => ({ root: "/fixture", remote: repository.url, branch: "feature", frameworks: ["Next.js"], integrations: ["posthog"], warnings: [] }),
    sleep: async () => {},
  };
  return { options, calls, messages, controller, api, setAccount: (s: AccountSettings) => account = s,
    setRun: (r: SetupRun | null) => record = r, setPending: (p: SetupPending) => pending = p, pending: () => pending };
}

test("wizard connects the detected repo, chooses mode, persists before writes and displays real recorded progress", async () => {
  const h = harness(["local", "", "public", true, "continue", "supervised", true]);
  expect((await setupWizard(h.options))?.mode).toBe("supervised");
  const connection = h.calls.find(c => c.action === "repository")!.value;
  expect(connection).toMatchObject({ input: { expectedVersion: 1, url: repository.url, branch: "main", discoverDefaultBranch: true, clearToken: true } });
  expect(h.calls.filter(c => c.action === "start")).toHaveLength(1);
  expect(h.pending()).toBeNull();
  expect(h.messages.join("\n")).toContain("Model access: not configured");
  expect(h.messages.join("\n")).toContain("Read repository");
  expect(h.messages.join("\n")).toContain("posthog, sentry");
  expect(h.messages.join("\n")).not.toContain("session-canary");
});

test("browser repository handoff explicitly refreshes workspace; integration handoff remains pinned", async () => {
  const h = harness(["browser", true, "browser", true, "show"]);
  h.options.io.open = url => {
    h.calls.push({ action: "open", value: url });
    h.setAccount({ ...settings(), version: 2, workspaceId: "ws-after", repository });
    h.setRun(run());
  };
  await setupWizard(h.options);
  expect(h.calls.filter(c => c.action === "settings").map(c => c.value)).toEqual([undefined, true, undefined]);
  expect(h.calls.filter(c => c.action === "start" || c.action === "repository")).toEqual([]);
});

test("a pending browser opener cannot block either handoff prompt or its cancellation", async () => {
  for (const handoff of ["repository", "integrations"]) {
    const h = harness(handoff === "repository" ? ["browser"] : ["saved", "browser"],
      { ...settings(), workspaceId: "ws-after", repository });
    let prompted = false;
    h.options.io.open = () => new Promise<void>(() => {});
    h.options.ui.confirm = async () => {
      prompted = true;
      queueMicrotask(() => h.controller.abort(new CliCancelledError()));
      await pause(10_000, h.controller.signal);
      return true;
    };
    // Bound failure cleanup without ever settling the opener.
    const timeout = setTimeout(() => h.controller.abort(new CliCancelledError()), 500);
    try { await expect(setupWizard(h.options)).rejects.toBeInstanceOf(CliCancelledError); }
    finally { clearTimeout(timeout); h.controller.abort(); }
    expect(prompted).toBe(true);
    expect(h.calls.some(c => c.action === "start" || c.action === "repository")).toBe(false);
  }
}, 2_000);

test("browser handoffs retain a usable URL after synchronous or asynchronous launch failure", async () => {
  for (const asynchronous of [false, true]) {
    const h = harness(["browser", false]);
    h.options.io.open = () => {
      if (asynchronous) return Promise.reject(new Error("private launcher detail"));
      throw new Error("private launcher detail");
    };
    await expect(setupWizard(h.options)).rejects.toBeInstanceOf(CliCancelledError);
    expect(h.messages.join("\n")).toContain("https://ephyra.example/app/#/onboarding");
    expect(h.messages.join("\n")).toContain("Open the console link above");
    expect(h.messages.join("\n")).not.toContain("private launcher detail");
    expect(h.calls.some(c => c.action === "start" || c.action === "repository")).toBe(false);
  }
});

test("a pending setup reconciles only its exact receipt and resumes without prompting or starting again", async () => {
  const h = harness([], { ...settings(), workspaceId: "ws-after", repository });
  h.setRun(run());
  h.setPending({ kind: "setup", key: run().operationKey!, workspace: "ws-after" });
  await setupWizard(h.options);
  expect(h.calls).toEqual([{ action: "settings", value: undefined }, { action: "current", value: run().operationKey }]);
  expect(h.pending()).toBeNull();
});

test("unknown setup or repository outcomes never trigger another write on restart", async () => {
  for (const kind of ["setup", "repository"] as const) {
    const h = harness([], { ...settings(), version: 99, workspaceId: "ws-after", repository });
    const pending: SetupPending = kind === "setup"
      ? { kind, key: run().operationKey!, workspace: "ws-after" }
      : { kind, key: run().operationKey!, workspace: "ws-after", version: 1, url: repository.url, branch: repository.branch };
    h.setPending(pending);
    await expect(setupWizard(h.options)).rejects.toThrow(kind === "setup" ? "not confirmed" : "still unconfirmed");
    expect(h.pending()).toEqual(pending);
    expect(h.calls.some(c => c.action === "start" || c.action === "repository")).toBe(false);
  }
});

test("cancellation or a lost start response keeps the operation key and never claims completion", async () => {
  const h = harness(["saved", "continue", "autonomous", true], { ...settings(), workspaceId: "ws-after", repository });
  h.api.start = async (_mode, key) => { throw new SetupWriteUnknown(key); };
  await expect(setupWizard(h.options)).rejects.toBeInstanceOf(SetupWriteUnknown);
  expect(h.pending()?.kind).toBe("setup");
  expect(h.messages.join("\n")).not.toContain("Setup is ready");
});

test("failed setup can be explicitly rechecked; blocked status is reported without invented success", async () => {
  const h = harness(["saved", "continue", "recheck", "autonomous", true], { ...settings(), workspaceId: "ws-after", repository });
  h.setRun(run("failed"));
  await setupWizard(h.options);
  expect(h.calls.filter(c => c.action === "start")).toHaveLength(1);
  const blocked = harness(["saved", "continue", "show"], { ...settings(), workspaceId: "ws-after", repository });
  blocked.setRun(run("blocked"));
  expect((await setupWizard(blocked.options))?.status).toBe("blocked");
  expect(blocked.messages.join("\n")).toContain("Connect a runner");
  expect(blocked.messages.join("\n")).not.toContain("Setup is ready");
});

test("stopping before confirmation makes no repository or setup write", async () => {
  const h = harness(["local", "", "public", false]);
  await expect(setupWizard(h.options)).rejects.toBeInstanceOf(CliCancelledError);
  expect(h.calls.map(c => c.action)).toEqual(["settings"]);
  expect(h.pending()).toBeNull();
});

test("follow polls the same run, emits only changes, stops at terminal states and detaches on abort", async () => {
  const controller = new AbortController();
  const updates: string[] = [];
  const responses = [run("running"), run("running"), run("blocked")];
  const outcome = await followSetup({ current: async key => { expect(key).toBe(run().operationKey); return responses.shift()!; } }, run("queued"), {
    signal: controller.signal, sleep: async () => {}, update: value => updates.push(value.status),
  });
  expect(outcome.status).toBe("blocked");
  expect(updates).toEqual(["queued", "running", "blocked"]);
  const abort = new AbortController();
  let reads = 0;
  await expect(followSetup({ current: async () => { reads++; return run("running"); } }, run("running"), {
    signal: abort.signal, update: () => {}, sleep: async () => { abort.abort(new CliCancelledError()); abort.signal.throwIfAborted(); },
  })).rejects.toBeInstanceOf(CliCancelledError);
  expect(reads).toBe(0);
  await expect(followSetup({ current: async () => ({ ...run(), id: "other" }) }, run("running"), {
    signal: controller.signal, update: () => {}, sleep: async () => {},
  })).rejects.toThrow("recorded setup changed");
});

test("signals and timers are cleaned up, and prompts require both terminal streams without JSON", async () => {
  const before = process.listenerCount("SIGINT");
  await expect(withCliSignal(async () => { throw new Error("fixture"); })).rejects.toThrow("fixture");
  expect(process.listenerCount("SIGINT")).toBe(before);
  const controller = new AbortController();
  const waiting = pause(60_000, controller.signal);
  controller.abort(new CliCancelledError());
  await expect(waiting).rejects.toBeInstanceOf(CliCancelledError);
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (json, input, output) => {
    expect(canPrompt(json, input, output)).toBe(!json && input && output);
  }));
});

test("repository and server prompts reject embedded secrets and unsupported schemes", () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z0-9]{1,25}$/), secret => {
    expect(repositoryAddressError(`https://user:${secret}@git.example/team/app`)).toBeDefined();
    expect(repositoryAddressError(`https://git.example/team/app?token=${secret}`)).toBeDefined();
    expect(serverAddressError(`https://ephyra.example?token=${secret}`)).toBeDefined();
  }));
  expect(repositoryAddressError(repository.url)).toBeUndefined();
  expect(repositoryAddressError("ssh://git@git.example/app")).toBeDefined();
  expect(serverAddressError("http://127.0.0.1:4317")).toBeUndefined();
  expect(serverAddressError("http://remote.example")).toBeDefined();
});

test("real CLI completion and automation paths need no sign-in and never start a wizard", async () => {
  const path = `${import.meta.dir}/../src/main.ts`;
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, path, ...args], {
      env: { PATH: process.env.PATH, EPHYRA_CREDENTIALS: "/nonexistent/ephyra-test-credentials", NO_COLOR: "1" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  const completion = await invoke(["complete", "--", "runs", "--status", ""]);
  expect(completion.code).toBe(0); expect(completion.out).toContain("running");
  const blocked = await invoke(["setup", "--interactive", "--json"]);
  expect(blocked.code).toBe(1); expect(blocked.out).toBe(""); expect(JSON.parse(blocked.err).error).toContain("interactive terminal");
  const pipe = await invoke(["setup", "--interactive"]);
  expect(pipe.code).toBe(1); expect(pipe.err).toContain("interactive terminal"); expect(pipe.out).toBe("");
  expect((await invoke(["complete", "bash", "--json"])).err).toContain("Omit --json");
});
