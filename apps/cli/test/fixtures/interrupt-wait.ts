// Run under a PTY by interactive.test.ts: the real Clack-backed UI waiting on a request that only ends on abort.
// Mirrors main.ts: withCliSignal owns cancellation, runCli's exitCodeFor sets the status. No network: fetch is injected.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exitCodeFor } from "../../src/commands/cli";
import { clackUi, withCliSignal } from "../../src/commands/interactive";
import { setupWizard } from "../../src/commands/setup-wizard";

const [mode, config] = process.argv.slice(2) as ["read" | "write", string];
const ready = (stage: string) => writeFileSync(join(config, "ready"), stage);
const hang = (signal: AbortSignal) => new Promise<never>((_, reject) =>
  signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
const account = {
  did: "did:plc:fixture", version: 1, workspaceId: "ws-fixture",
  repository: { url: "https://git.fixture.invalid/team/app.git", branch: "main", head: "a".repeat(40), verifiedAt: "2026-11-12T00:00:00Z", credentialConfigured: false },
  model: { provider: "none", model: "", baseUrl: null, keyConfigured: false, status: "not_configured", checkedAt: null, detail: null },
  onboarding: { status: "new", updatedAt: "2026-11-12T00:00:00Z" }, execution: "not_configured",
};
let finallyRan = false;
try {
  await withCliSignal(async signal => {
    const ui = clackUi(signal);
    try {
      if (mode === "read") {
        await ui.work("Checking server…", () => { ready("read"); return hang(signal); });
        return;
      }
      const answers = ["saved", "continue", "autonomous"];
      const fetcher = (async (input: URL, init: RequestInit) => {
        const path = new URL(input).pathname;
        if (path === "/v1/account") return Response.json(account);
        if (path === "/v1/account/telemetry/detected") return Response.json({ providers: [] });
        if (path === "/v1/setup" && init.method !== "POST") return Response.json(null);
        if (path === "/v1/setup" && init.method === "POST") { ready("write"); return hang(init.signal!); }
        throw new Error(`unexpected ${path}`);
      }) as unknown as typeof fetch;
      await setupWizard({
        cwd: config, creds: { url: "https://fixture.invalid", token: "fixture-only", did: account.did }, signal,
        ui: { ...ui, select: async () => answers.shift()!, confirm: async () => true },
        io: { print() {}, sleep: async () => {}, env: { EPHYRA_CREDENTIALS: join(config, "credentials.json") }, fetch: fetcher },
        discover: async () => ({ root: null, frameworks: [], integrations: [], warnings: [] }),
      });
    } finally { finallyRan = true; }
  }, "Stopped waiting.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = exitCodeFor(error);
}
const receipts = readdirSync(config).filter(name => name.startsWith("setup-") && name.endsWith(".json"));
writeFileSync(join(config, "result.json"), JSON.stringify({
  finallyRan,
  receipts: receipts.map(name => JSON.parse(readFileSync(join(config, name), "utf8")).kind),
}));
