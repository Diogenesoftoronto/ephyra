// Built-console browser contract with offline HTTP fixtures. No upstream connection or provider is contacted.
// Build first, then: env -u LD_LIBRARY_PATH bun apps/console/scripts/knowledge.ts
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KnowledgeUpdate, type AccountSettings, type KnowledgeCatalog } from "@ephyra/core";
import { ACCOUNT_FIXTURE } from "../src/fake/account.ts";
import { FakeApi } from "../src/fake/api.ts";
import { KNOWLEDGE_CATALOG_FIXTURE, KNOWLEDGE_SELECTION_FIXTURE } from "../src/fake/knowledge.ts";
import { knowledgeToolKey } from "../src/components/knowledge-selection.ts";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const artifacts = join(root, "artifacts/knowledge");
await mkdir(artifacts, { recursive: true });
const app = serve(join(root, "dist"), "/app/");
const browser = await launch();
const completed: string[] = [];

async function fixture(name: string, width: number, initial = ACCOUNT_FIXTURE) {
  const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const errors: string[] = [];
  const unexpected: string[] = [];
  const writes: Array<{ input: KnowledgeUpdate; key: string; did: string }> = [];
  const overview = new FakeApi({ empty: true });
  const state = {
    account: structuredClone(initial),
    catalog: { ...structuredClone(KNOWLEDGE_CATALOG_FIXTURE), status: "needs_sign_in", sources: [], detail: "Fixture: sign in to connect your knowledge." } as KnowledgeCatalog,
    loseSave: false,
    rejectSave: false,
    holdReadDid: "",
    holdSave: false,
    reads: 0,
    skips: 0,
  };
  const held: Array<() => void> = [];
  const release = () => { while (held.length) held.shift()!(); };
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== app.url) {
      unexpected.push(`external request: ${url.origin}${url.pathname}`);
      return route.abort();
    }
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    const identity = { principal: state.account.did, alias: "fixture-reader", kind: "human", approver: true };
    if (url.pathname === "/auth/session") return json({ signIn: true, identity });
    if (url.pathname === "/v1/me") return json(identity);
    if (url.pathname === "/v1/account") return json(state.account);
    if (url.pathname === "/v1/account/workspaces") return json([
      { workspaceId: state.account.workspaceId, ownerDid: state.account.did, name: "Offline fixture", role: "owner" },
    ]);
    if (url.pathname === "/v1/inbox") return json([]);
    if (url.pathname === "/v1/activity") return json([]);
    if (url.pathname === "/v1/runs") return json([]);
    if (url.pathname === "/v1/usage") return json(await overview.usage());
    if (url.pathname === "/v1/account/knowledge") {
      const did = request.headers()["x-ephyra-account"];
      assert.equal(request.headers().authorization, undefined, "cookie sessions do not send empty bearer credentials");
      if (request.method() === "GET") {
        state.reads++;
        const enabled = state.account.knowledge?.enabled && state.account.knowledge.workspaceId === state.account.workspaceId;
        const snapshot = enabled ? structuredClone(state.catalog) : {
          ...structuredClone(state.catalog), status: "disabled", sources: [], detail: "Fixture: knowledge is optional.",
        };
        if (state.holdReadDid === did) await new Promise<void>((resolve) => held.push(resolve));
        return json(snapshot);
      }
      assert.equal(did, state.account.did);
      const input = KnowledgeUpdate.parse(request.postDataJSON());
      const key = request.headers()["idempotency-key"]!;
      assert.ok(key);
      writes.push({ input, key, did });
      assert.equal(input.workspaceId, state.account.workspaceId);
      if (state.rejectSave || input.expectedVersion !== state.account.version) {
        state.rejectSave = false;
        return json({ error: "Settings changed", code: "conflict" }, 409);
      }
      state.account = {
        ...state.account, version: state.account.version + 1,
        knowledge: { enabled: input.enabled, workspaceId: input.workspaceId, sources: input.sources, updatedAt: `fixture-revision-${state.account.version + 1}` },
      };
      const snapshot = structuredClone(state.account);
      if (state.holdSave) await new Promise<void>((resolve) => held.push(resolve));
      if (state.loseSave) { state.loseSave = false; return route.abort("connectionreset"); }
      return json(snapshot);
    }
    if (url.pathname === "/v1/account/onboarding") {
      assert.equal(request.postDataJSON().action, "skip");
      state.skips++;
      state.account = { ...state.account, version: state.account.version + 1, onboarding: { ...state.account.onboarding, status: "skipped" } };
      return json(state.account);
    }
    if (url.pathname === "/v1/account/repository") {
      assert.equal(request.postDataJSON().expectedVersion, state.account.version);
      state.account = {
        ...state.account, version: state.account.version + 1, workspaceId: "fixture-replacement-workspace",
        repository: { url: request.postDataJSON().url, branch: "main", head: "a".repeat(40), verifiedAt: "2026-11-08T12:00:00.000Z", credentialConfigured: false },
      };
      return json(state.account);
    }
    if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/auth/")) {
      unexpected.push(`unexpected API request: ${request.method()} ${url.pathname}`);
      return json({ error: "Offline fixture has no such route" }, 404);
    }
    return route.continue();
  });
  return {
    page, state, writes, release,
    async finish() {
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow");
      await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
      completed.push(name);
      console.log(`PASS ${name}`);
    },
    async close() { release(); await context.close(); },
    async failure() { await page.screenshot({ path: join(artifacts, `${name}-failure.png`), fullPage: true }); },
  };
}

try {
  for (const width of [1440, 390]) {
    const f = await fixture(`optional-and-permissions-${width}`, width);
    const { page, state, writes } = f;
    try {
      await page.goto(`${app.url}/app/#/onboarding`);
      await page.getByRole("heading", { name: "Knowledge and MCP connections", exact: true }).waitFor();
      assert.equal(writes.length, 0, "opening onboarding does not opt in");
      await page.getByRole("button", { name: "Explore first", exact: true }).click();
      await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
      assert.equal(state.skips, 1);
      assert.equal(writes.length, 0, "skip needs no connection choice");
      await page.evaluate(() => { location.hash = "#/settings"; });
      const repositoryTab = page.getByRole("tab", { name: "Repository", exact: true });
      await repositoryTab.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      const knowledgeTab = page.getByRole("tab", { name: "Connections", exact: true });
      assert.equal(await knowledgeTab.getAttribute("aria-selected"), "true");
      assert.equal(await knowledgeTab.evaluate((element) => element === document.activeElement), true, "keyboard tabs move focus with selection");
      await page.getByRole("button", { name: "Connect knowledge", exact: true }).click();
      const authorization = page.getByRole("link", { name: "Continue with Not Organic", exact: true });
      await authorization.waitFor();
      assert.deepEqual(writes[0].input.sources, [], "opt-in never selects sources automatically");
      assert.equal(writes[0].input.enabled, true);
      assert.equal(await authorization.getAttribute("href"), state.catalog.authorizeUrl);
      const portal = page.getByRole("link", { name: "Manage connections in Not Organic ↗", exact: true });
      assert.equal(await portal.getAttribute("href"), state.catalog.manageUrl, "app grant and return context are preserved");
      assert.equal(await portal.getAttribute("rel"), "noopener noreferrer");
      state.catalog = { ...structuredClone(KNOWLEDGE_CATALOG_FIXTURE), sources: [] };
      await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
      await page.getByText("No sources are available to Ephyra yet. Add a connection or allow access in Not Organic, then refresh here.", { exact: true }).waitFor();
      state.catalog = { ...state.catalog, status: "unavailable", detail: "Fixture: connections are temporarily unavailable." };
      await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
      await page.getByText("Fixture: connections are temporarily unavailable.", { exact: true }).waitFor();
      state.catalog = structuredClone(KNOWLEDGE_CATALOG_FIXTURE);
      await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
      const docs = page.getByRole("group", { name: "Product documentation", exact: true });
      await docs.waitFor();
      assert.equal(await docs.getByRole("checkbox").isChecked(), false);
      assert.equal(await docs.getByRole("combobox").inputValue(), "");
      await docs.getByRole("checkbox").check();
      await docs.getByRole("combobox").selectOption(knowledgeToolKey(KNOWLEDGE_SELECTION_FIXTURE[0]!.searchTool!));
      const issues = page.getByRole("group", { name: "Issue history", exact: true });
      await issues.getByText("About this connection’s tools", { exact: true }).click();
      await issues.getByText("create_issue", { exact: true }).waitFor();
      assert.equal(await issues.getByRole("option", { name: "create_issue", exact: true }).count(), 0, "unsupported tools stay unselectable");
      await page.getByRole("button", { name: "Save connections", exact: true }).click();
      await page.getByText("Knowledge preferences saved.", { exact: true }).waitFor();
      assert.deepEqual(writes.at(-1)!.input.sources, KNOWLEDGE_SELECTION_FIXTURE);
      assert.ok(await page.getByRole("button", { name: "Save connections", exact: true }).isDisabled());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "source controls fit the viewport");
      await page.screenshot({ path: join(artifacts, `selected-sources-${width}.png`), fullPage: true });
      const savesBeforeRefresh = writes.length;
      state.catalog.sources[0].tools[0].definitionHash = "d".repeat(64);
      state.catalog.sources[0].tools[0].description = '<script>globalThis.__knowledgeScript = true</script>';
      const changedRead = page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/account/knowledge" && response.request().method() === "GET");
      await page.evaluate(() => dispatchEvent(new Event("focus")));
      await changedRead;
      await page.getByText("The saved search tool changed or is unavailable. Remove it or explicitly choose its current version.", { exact: true }).waitFor();
      assert.equal(await docs.getByRole("combobox").inputValue(), "unavailable");
      assert.equal(writes.length, savesBeforeRefresh, "focus refresh never changes saved permission");
      assert.ok(await page.getByRole("button", { name: "Save connections", exact: true }).isDisabled());
      await docs.getByText("About this connection’s tools", { exact: true }).click();
      assert.ok((await docs.innerText()).includes("<script>"));
      assert.equal(await docs.locator("script").count(), 0);
      assert.equal(await page.evaluate(() => (globalThis as typeof globalThis & { __knowledgeScript?: boolean }).__knowledgeScript), undefined);
      await docs.getByRole("combobox").selectOption(knowledgeToolKey(state.catalog.sources[0].tools[0]));
      await page.getByRole("button", { name: "Save connections", exact: true }).click();
      await page.getByText("Knowledge preferences saved.", { exact: true }).waitFor();
      assert.equal(writes.at(-1)!.input.sources[0].searchTool!.definitionHash, "d".repeat(64));
      state.catalog.sources = state.catalog.sources.slice(1);
      await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
      await page.getByText("This saved source is no longer available to Ephyra. Remove it or restore access in Not Organic.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Remove saved source", exact: true }).click();
      await page.getByRole("button", { name: "Save connections", exact: true }).click();
      await page.getByText("Knowledge preferences saved.", { exact: true }).waitFor();
      assert.deepEqual(writes.at(-1)!.input.sources, []);
      await page.getByRole("button", { name: "Disconnect knowledge", exact: true }).click();
      await page.getByRole("button", { name: "Connect knowledge", exact: true }).waitFor();
      assert.equal(writes.at(-1)!.input.enabled, false);
      assert.deepEqual(writes.at(-1)!.input.sources, []);
      await f.finish();
    } catch (error) { await f.failure(); throw error; }
    finally { await f.close(); }
  }

  const enabled: AccountSettings = {
    ...ACCOUNT_FIXTURE, onboarding: { ...ACCOUNT_FIXTURE.onboarding, status: "skipped" },
    knowledge: { enabled: true, workspaceId: ACCOUNT_FIXTURE.workspaceId, sources: [], updatedAt: "fixture-initial" },
  };
  const f = await fixture("revision-and-uncertain-save", 1440, enabled);
  try {
    const { page, state, writes } = f;
    state.catalog = structuredClone(KNOWLEDGE_CATALOG_FIXTURE);
    await page.goto(`${app.url}/app/#/settings`);
    await page.getByRole("tab", { name: "Connections", exact: true }).click();
    const resource = page.getByRole("group", { name: "Product documentation", exact: true }).getByRole("checkbox");
    await resource.check();
    state.rejectSave = true;
    state.account.version++;
    await page.getByRole("button", { name: "Save connections", exact: true }).click();
    await page.getByText("Settings changed in another window. Refresh saved settings, then review your changes.", { exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Save connections", exact: true }).isDisabled());
    await page.getByRole("button", { name: "Refresh saved settings", exact: true }).click();
    await page.getByText("Latest saved settings loaded. Review them before trying again.", { exact: true }).waitFor();
    assert.equal(await resource.isChecked(), false, "refresh shows saved choices rather than retrying the draft");
    await resource.check();
    state.loseSave = true;
    await page.getByRole("button", { name: "Save connections", exact: true }).click();
    await page.getByText("The connection ended before we could confirm the save. It may have completed. Refresh saved settings before making another change.", { exact: true }).waitFor();
    const before = writes.length;
    assert.ok(await page.getByRole("button", { name: "Save connections", exact: true }).isDisabled());
    assert.ok(await page.getByRole("button", { name: "Disconnect knowledge", exact: true }).isDisabled());
    await page.getByRole("button", { name: "Refresh saved settings", exact: true }).click();
    await page.getByText("Latest saved settings loaded. Review them before trying again.", { exact: true }).waitFor();
    assert.equal(await resource.isChecked(), true);
    assert.equal(writes.length, before, "reconciliation is a read, never a repeated save");
    assert.notEqual(writes[0].key, writes[1].key, "reviewed revision creates a distinct intent");
    await f.finish();
  } catch (error) { await f.failure(); throw error; }
  finally { await f.close(); }

  const isolation = await fixture("account-and-workspace-isolation", 390, enabled);
  try {
    const { page, state } = isolation;
    state.catalog = structuredClone(KNOWLEDGE_CATALOG_FIXTURE);
    await page.goto(`${app.url}/app/#/settings`);
    await page.getByRole("tab", { name: "Connections", exact: true }).click();
    await page.getByRole("group", { name: "Product documentation", exact: true }).getByRole("checkbox").check();
    state.holdReadDid = state.account.did;
    const oldRead = page.waitForRequest((request) => new URL(request.url()).pathname === "/v1/account/knowledge" && request.method() === "GET");
    await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
    await oldRead;
    await page.getByRole("tab", { name: "Repository", exact: true }).click();
    await page.getByRole("textbox", { name: "Repository address", exact: true }).fill("https://git.example.org/fixture/new-workspace.git");
    await page.getByRole("button", { name: "Save repository", exact: true }).click();
    // Workspace changes mount fresh identity/context. Release old catalog responses only after the new form appears.
    await page.getByRole("tab", { name: "Connections", exact: true }).click();
    await page.getByRole("button", { name: "Connect knowledge", exact: true }).waitFor();
    state.holdReadDid = "";
    isolation.release();
    await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
    await page.getByRole("button", { name: "Connect knowledge", exact: true }).waitFor();
    assert.equal(await page.getByRole("group", { name: "Product documentation", exact: true }).count(), 0, "old workspace drafts/catalog are cleared");
    await page.getByRole("button", { name: "Connect knowledge", exact: true }).click();
    const resource = page.getByRole("group", { name: "Product documentation", exact: true }).getByRole("checkbox");
    await resource.check();
    state.holdSave = true;
    const oldWrite = page.waitForRequest((request) => new URL(request.url()).pathname === "/v1/account/knowledge" && request.method() === "PUT");
    await page.getByRole("button", { name: "Save connections", exact: true }).click();
    await oldWrite;
    state.account = { ...structuredClone(ACCOUNT_FIXTURE), did: "did:plc:second-knowledge-account", workspaceId: "fixture-second-account", onboarding: { ...ACCOUNT_FIXTURE.onboarding, status: "skipped" } };
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await page.getByRole("tab", { name: "Connections", exact: true }).click();
    await page.getByRole("button", { name: "Connect knowledge", exact: true }).waitFor();
    isolation.release();
    state.holdSave = false;
    await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
    assert.equal(await page.getByRole("group", { name: "Product documentation", exact: true }).count(), 0, "late saved results do not cross account boundaries");
    await page.getByRole("tab", { name: "Account", exact: true }).click();
    await page.getByText("did:plc:second-knowledge-account", { exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Sign out", exact: true }).isVisible());
    await isolation.finish();
  } catch (error) { await isolation.failure(); throw error; }
  finally { await isolation.close(); }

  await writeFile(join(artifacts, "verification.json"), JSON.stringify({
    passed: true, transport: "built console with offline HTTP fixtures", cases: completed,
    unverified: ["hosted Not Organic authorization", "upstream MCP connectors", "live autonomous research"],
  }, null, 2));
  console.log(`PASS ${completed.length} knowledge browser scenarios; artifacts: ${artifacts}`);
} finally {
  await browser.close();
  app.stop();
}
