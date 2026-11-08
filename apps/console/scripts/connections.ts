// Built console, isolated HTTP fixtures. No repository, PostHog, webhook or model is contacted.
// Build first: env -u LD_LIBRARY_PATH bun apps/console/scripts/connections.ts
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PeopleUpdate, RepositoryUpdate, TelemetryUpdate, type AccountSettings, type SetupRun } from "@ephyra/core";
import { ACCOUNT_FIXTURE, FakeAccountApi } from "../src/fake/account.ts";
import { FakeApi } from "../src/fake/api.ts";
import { KNOWLEDGE_CATALOG_FIXTURE } from "../src/fake/knowledge.ts";
import { QUESTION_FIXTURE } from "../src/fake/connections.ts";
import { SETUP_FIXTURE } from "../src/fake/setup.ts";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const artifacts = join(root, "artifacts/connections");
await mkdir(artifacts, { recursive: true });
const app = serve(join(root, "dist"), "/app/");
const browser = await launch();
const completed: string[] = [];

async function fixture(name: string, width: number, initial: AccountSettings = ACCOUNT_FIXTURE) {
  const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const errors: string[] = [];
  const unexpected: string[] = [];
  const overview = new FakeApi({ empty: true });
  const writes: { path: string; input: Record<string, unknown>; key: string }[] = [];
  const ownerQuestion = { ...structuredClone(QUESTION_FIXTURE), question: "Fixture question: <script>globalThis.__questionScript=true</script>" };
  const otherQuestion = { ...structuredClone(QUESTION_FIXTURE), id: "f".repeat(64),
    recipient: { id: "fixture-product", alias: "Product contact", roles: ["product" as const], areas: [] },
    delivery: { kind: "webhook" as const, status: "uncertain" as const } };
  const state = { account: structuredClone(initial), run: null as SetupRun | null,
    questions: [ownerQuestion, otherQuestion], loseAnswer: false, allowExact: true, loseConnection: false,
    holdConnection: false, rejectConnection: false };
  const held: Array<() => void> = [];
  const release = () => { while (held.length) held.shift()!(); };
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== app.url) {
      unexpected.push(`External request blocked: ${url.origin}${url.pathname}`);
      return route.abort();
    }
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    const identity = { principal: state.account.did, alias: "fixture-alias", kind: "human", approver: true };
    if (url.pathname === "/auth/session") return json({ signIn: true, identity });
    if (url.pathname === "/v1/me") return json(identity);
    if (url.pathname === "/v1/account") return json(state.account);
    if (url.pathname === "/v1/account/workspaces") return json([
      { workspaceId: state.account.workspaceId, ownerDid: state.account.did, name: "Offline fixture", role: "owner" },
    ]);
    if (url.pathname === "/v1/account/knowledge") return json({ ...KNOWLEDGE_CATALOG_FIXTURE, status: "disabled", sources: [] });
    if (["/v1/inbox", "/v1/activity", "/v1/runs"].includes(url.pathname)) return json([]);
    if (url.pathname === "/v1/usage") return json(await overview.usage());
    if (url.pathname.startsWith("/v1/account/") && request.method() === "PUT") {
      assert.equal(request.headers()["x-ephyra-account"], state.account.did);
      assert.equal(request.headers().authorization, undefined);
      const input = request.postDataJSON();
      const key = request.headers()["idempotency-key"]!;
      assert.ok(key);
      writes.push({ path: url.pathname, input, key });
      if (state.rejectConnection || input.expectedVersion !== state.account.version) {
        state.rejectConnection = false;
        return json({ error: "Settings changed" }, 409);
      }
      const account = new FakeAccountApi({ initial: state.account });
      if (url.pathname.endsWith("/telemetry")) state.account = await account.saveTelemetry(TelemetryUpdate.parse(input), key);
      else if (url.pathname.endsWith("/people")) state.account = await account.savePeople(PeopleUpdate.parse(input), key);
      else if (url.pathname.endsWith("/repository")) {
        state.account = await account.saveRepository(RepositoryUpdate.parse(input), key);
        state.account.repository!.branch = input.discoverDefaultBranch ? "fixture-default" : input.branch;
      } else if (url.pathname.endsWith("/onboarding")) state.account = await account.onboarding(input, key);
      else { unexpected.push(`Unimplemented account route ${url.pathname}`); return json({}, 404); }
      const snapshot = structuredClone(state.account);
      if (state.holdConnection) await new Promise<void>((resolve) => held.push(resolve));
      if (state.loseConnection) { state.loseConnection = false; return route.abort("connectionreset"); }
      return json(snapshot);
    }
    if (url.pathname === "/v1/setup") {
      assert.equal(request.headers()["x-ephyra-workspace"], state.account.workspaceId);
      if (request.method() === "POST") {
        const input = request.postDataJSON();
        const key = request.headers()["idempotency-key"]!;
        writes.push({ path: url.pathname, input, key });
        state.run = { ...structuredClone(SETUP_FIXTURE), operationKey: key, investigationActive: true,
          mode: input.mode, repository: state.account.repository! };
      }
      return json(state.run);
    }
    if (url.pathname.startsWith("/v1/questions")) {
      assert.equal(request.headers()["x-ephyra-workspace"], state.account.workspaceId);
      assert.equal(request.headers()["x-ephyra-principal"], state.account.did);
      if (url.pathname === "/v1/questions") return json(state.questions.filter((question) => !question.answer));
      const [, , , trail, questionId, action] = url.pathname.split("/");
      const question = state.questions.find((item) => item.id === questionId && item.trailId === decodeURIComponent(trail));
      if (!question) return json(null);
      if (action === "answer") {
        assert.equal(question.recipient?.did, state.account.did);
        const input = request.postDataJSON();
        const key = request.headers()["idempotency-key"]!;
        assert.ok(key);
        writes.push({ path: url.pathname, input, key });
        question.answer = { text: input.text, by: state.account.did, at: "2026-11-08T12:01:00.000Z", accepted: true };
        question.status = "answered";
        question.checks.push({ phase: "answer", model: "fixture/not-a-live-model", accepted: true,
          request: { fixture: true }, response: { fixture: true } });
        if (state.loseAnswer) { state.loseAnswer = false; return route.abort("connectionreset"); }
      }
      return json(state.allowExact ? question : null);
    }
    if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/auth/")) {
      unexpected.push(`Unexpected API: ${request.method()} ${url.pathname}`);
      return json({}, 404);
    }
    return route.continue();
  });
  return { page, state, writes, release,
    async finish() {
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow");
      await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
      completed.push(name); console.log(`PASS ${name}`);
    },
    async failure() { await page.screenshot({ path: join(artifacts, `${name}-failure.png`), fullPage: true }); },
    async close() { release(); await context.close(); },
  };
}

try {
  for (const width of [1440, 390]) {
    const f = await fixture(`optional-sources-and-questions-${width}`, width);
    try {
      const { page, state, writes } = f;
      await page.goto(`${app.url}/app/#/onboarding`);
      await page.getByRole("heading", { name: "Let Ephyra set up your application" }).waitFor();
      assert.equal(await page.locator(".connection-panels details[open]").count(), 0);
      assert.equal(writes.length, 0);
      await page.getByRole("button", { name: "Explore first", exact: true }).click();
      await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
      assert.equal(writes.length, 1, "skip needs no signal or contact configuration");
      await page.evaluate(() => { location.hash = "#/settings"; });
      await page.getByRole("tab", { name: "Repository", exact: true }).focus();
      await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
      const tab = page.getByRole("tab", { name: "Connections", exact: true });
      assert.equal(await tab.evaluate((element) => element === document.activeElement), true);
      await page.locator("summary").filter({ hasText: "PostHog signals" }).click();
      const telemetry = page.getByRole("form", { name: "PostHog connection" });
      await telemetry.getByRole("checkbox", { name: "Use PostHog for this workspace" }).check();
      await telemetry.getByLabel("PostHog origin", { exact: true }).fill("https://posthog.example.com");
      await telemetry.getByLabel("PostHog project ID", { exact: true }).fill("42");
      await telemetry.getByLabel("PostHog personal API key", { exact: true }).fill("fixture-private-posthog");
      await telemetry.getByRole("checkbox", { name: "Include session recording context" }).check();
      await telemetry.getByRole("button", { name: "Save PostHog connection" }).click();
      await telemetry.getByText("PostHog preferences saved.", { exact: true }).waitFor();
      assert.equal(writes.at(-1)!.input.projectId, "42");
      assert.equal(writes.at(-1)!.input.includeRecordings, true);
      assert.equal(await telemetry.getByLabel("Replace PostHog personal API key").inputValue(), "");
      await telemetry.getByText("Saved, not verified", { exact: true }).waitFor();
      await page.locator("summary").filter({ hasText: "Contact routing" }).click();
      const people = page.getByRole("form", { name: "Contact routing" });
      assert.ok(await people.getByRole("button", { name: "Save contact routing" }).isDisabled());
      await people.getByRole("button", { name: "Add recipient" }).click();
      await people.getByLabel("Recipient ID", { exact: true }).fill("product-contact");
      await people.getByLabel("Recipient alias", { exact: true }).fill("Product contact");
      await people.getByRole("checkbox", { name: "maintainer", exact: true }).uncheck();
      await people.getByRole("checkbox", { name: "product", exact: true }).check();
      await people.getByLabel("Areas (optional)").pressSequentially("billing, onboarding");
      await people.getByLabel("Delivery webhook URL").fill("https://delivery.example.com/questions");
      await people.getByLabel("Delivery token", { exact: true }).fill("fixture-private-delivery");
      await people.getByRole("button", { name: "Save contact routing" }).click();
      await people.getByText("Contact routing saved.", { exact: true }).waitFor();
      assert.deepEqual(state.account.people!.contacts[1].areas, ["billing", "onboarding"]);
      assert.deepEqual(state.account.people!.contacts[1].roles, ["product"]);
      assert.equal(await people.getByLabel("Replace delivery token").inputValue(), "");
      await page.screenshot({ path: join(artifacts, `settings-${width}.png`), fullPage: true });
      await page.evaluate(() => { location.hash = "#/inbox"; });
      const queue = page.getByRole("region", { name: "Investigation questions" });
      await queue.getByRole("heading", { name: "Questions from Ephyra" }).waitFor();
      await queue.getByText("This question is addressed to another recipient.", { exact: true }).waitFor();
      assert.equal(await queue.getByRole("textbox", { name: "Your answer", exact: true }).count(), 1);
      assert.equal(await queue.locator("script").count(), 0);
      assert.equal(await page.evaluate(() => (globalThis as typeof globalThis & { __questionScript?: boolean }).__questionScript), undefined);
      const record = queue.locator(".question-record").first();
      await record.getByText("Why this question and what was checked", { exact: true }).click();
      await record.locator("summary").filter({ hasText: "Question check · accepted" }).click();
      await record.getByText("fixture/not-a-live-model", { exact: true }).waitFor();
      await record.getByRole("textbox", { name: "Your answer", exact: true }).fill("Fixture: archived projects stay hidden.");
      await record.getByRole("button", { name: "Send answer", exact: true }).click();
      await record.getByRole("region", { name: "Recorded answer" }).waitFor();
      assert.equal(writes.filter((write) => write.path.endsWith("/answer")).length, 1);
      assert.ok(!JSON.stringify(state.account).includes("fixture-private-"), "saved account has no returned secret");
      await f.finish();
    } catch (error) { await f.failure(); throw error; } finally { await f.close(); }
  }

  const native = await fixture("native-repository-inputs", 390);
  try {
    const { page, writes } = native;
    await page.goto(`${app.url}/app/#/onboarding`);
    const repository = page.getByRole("form", { name: "Repository settings" });
    await repository.getByLabel("Repository address", { exact: true }).fill("rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5");
    await repository.getByRole("button", { name: "Connect and set up automatically" }).click();
    await page.getByRole("heading", { name: "Investigation active · landing needs a connection", exact: true }).waitFor();
    assert.equal(writes[0].input.url, "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5");
    assert.equal(writes[0].input.discoverDefaultBranch, true);
    assert.equal(writes.filter((write) => write.path === "/v1/setup").length, 1);
    await page.evaluate(() => { location.hash = "#/settings"; });
    await page.getByLabel("Repository address", { exact: true }).fill("at://did:plc:alice/org.tangled.repo.declaration/my-app");
    await page.getByText("Private repository access", { exact: true }).click();
    await page.getByLabel("Credential host (optional)").fill("https://knot.example.org");
    await page.getByLabel("Access token", { exact: true }).fill("fixture-native-token");
    await page.getByRole("button", { name: "Save repository", exact: true }).click();
    await page.getByText("Repository verified and saved.", { exact: true }).waitFor();
    assert.equal(writes.at(-1)!.input.url, "at://did:plc:alice/org.tangled.repo.declaration/my-app");
    assert.equal(writes.at(-1)!.input.credentialHost, "https://knot.example.org");
    assert.equal(await page.getByLabel("Replace access token", { exact: true }).inputValue(), "");
    await native.finish();
  } catch (error) { await native.failure(); throw error; } finally { await native.close(); }

  const skipped = { ...ACCOUNT_FIXTURE, onboarding: { ...ACCOUNT_FIXTURE.onboarding, status: "skipped" as const } };
  const lost = await fixture("lost-answer-reload-reconciliation", 1440, skipped);
  try {
    const { page, state, writes } = lost;
    await page.goto(`${app.url}/app/#/inbox`);
    await page.getByRole("textbox", { name: "Your answer", exact: true }).fill("Private factual answer stored on the server only.");
    state.loseAnswer = true; state.allowExact = false;
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await page.getByText(/The answer may have been saved/).waitFor();
    assert.ok(await page.getByRole("button", { name: "Send answer", exact: true }).isDisabled());
    const stored = await page.evaluate(() => JSON.stringify(sessionStorage));
    assert.ok(stored.includes("ephyra.question.pending"));
    assert.ok(!stored.includes("Private factual answer"));
    await page.reload();
    await page.getByText(/An earlier answer is still unconfirmed/).waitFor();
    assert.equal(writes.filter((write) => write.path.endsWith("/answer")).length, 1);
    state.allowExact = true;
    await page.getByRole("button", { name: "Refresh questions", exact: true }).click();
    await page.getByRole("region", { name: "Recorded answer" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send answer", exact: true }).count(), 0);
    assert.equal(writes.filter((write) => write.path.endsWith("/answer")).length, 1, "exact GET reconciles resumed quests without another answer");
    assert.ok(!(await page.evaluate(() => JSON.stringify(sessionStorage))).includes("ephyra.question.pending"));
    await lost.finish();
  } catch (error) { await lost.failure(); throw error; } finally { await lost.close(); }

  const settings = await fixture("settings-conflict-uncertain-save-and-account-isolation", 390, skipped);
  try {
    const { page, state, writes } = settings;
    await page.goto(`${app.url}/app/#/settings`);
    await page.getByRole("tab", { name: "Connections", exact: true }).click();
    await page.locator("summary").filter({ hasText: "PostHog signals" }).click();
    const telemetry = page.getByRole("form", { name: "PostHog connection" });
    async function fill() {
      await telemetry.getByRole("checkbox", { name: "Use PostHog for this workspace" }).check();
      await telemetry.getByLabel("PostHog origin", { exact: true }).fill("https://posthog.example.com");
      await telemetry.getByLabel("PostHog project ID", { exact: true }).fill("42");
      await telemetry.getByLabel("PostHog personal API key", { exact: true }).fill("fixture-private-posthog");
    }
    await fill();
    state.rejectConnection = true; state.account.version++;
    await telemetry.getByRole("button", { name: "Save PostHog connection" }).click();
    await telemetry.getByText("Settings changed in another window. Refresh saved settings, then review your changes.", { exact: true }).waitFor();
    assert.ok(await telemetry.getByRole("button", { name: "Save PostHog connection" }).isDisabled());
    await telemetry.getByRole("button", { name: "Refresh saved settings" }).click();
    await telemetry.getByText("Latest saved settings loaded. Review them before trying again.", { exact: true }).waitFor();
    assert.equal(await telemetry.getByRole("checkbox", { name: "Use PostHog for this workspace" }).isChecked(), false);
    assert.equal(await telemetry.getByLabel("PostHog personal API key", { exact: true }).inputValue(), "");
    assert.equal(writes.length, 1);
    await fill(); state.loseConnection = true;
    await telemetry.getByRole("button", { name: "Save PostHog connection" }).click();
    await telemetry.getByText(/The connection ended before we could confirm the save/).waitFor();
    assert.ok(await telemetry.getByRole("button", { name: "Save PostHog connection" }).isDisabled());
    await telemetry.getByRole("button", { name: "Refresh saved settings" }).click();
    await telemetry.getByText("Latest saved settings loaded. Review them before trying again.", { exact: true }).waitFor();
    assert.equal(await telemetry.getByRole("checkbox", { name: "Use PostHog for this workspace" }).isChecked(), true);
    assert.equal(writes.length, 2, "lost settings save reconciles with a read");
    assert.notEqual(writes[0].key, writes[1].key, "reviewing the new version creates a distinct intent");
    state.holdConnection = true;
    await telemetry.getByLabel("Replace PostHog personal API key", { exact: true }).fill("stale-account-secret");
    const oldSave = page.waitForRequest((request) => request.url().endsWith("/v1/account/telemetry") && request.method() === "PUT");
    await telemetry.getByRole("button", { name: "Save PostHog connection" }).click();
    await oldSave;
    state.account = { ...structuredClone(skipped), did: "did:plc:other-connections-account", workspaceId: "other-workspace" };
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await page.getByRole("tab", { name: "Account", exact: true }).click();
    await page.getByText("did:plc:other-connections-account", { exact: true }).waitFor();
    settings.release(); state.holdConnection = false;
    await page.getByRole("tab", { name: "Connections", exact: true }).click();
    await page.locator("summary").filter({ hasText: "PostHog signals" }).click();
    assert.equal(await telemetry.getByRole("checkbox", { name: "Use PostHog for this workspace" }).isChecked(), false);
    assert.equal(await telemetry.getByLabel("PostHog origin", { exact: true }).inputValue(), "");
    assert.equal(await telemetry.getByLabel("PostHog personal API key", { exact: true }).inputValue(), "");
    assert.equal(await telemetry.getByText("Saved, not verified", { exact: true }).count(), 0);
    assert.ok(!(await page.evaluate(() => JSON.stringify(sessionStorage))).includes("stale-account-secret"));
    await settings.finish();
  } catch (error) { await settings.failure(); throw error; } finally { await settings.close(); }

  await writeFile(join(artifacts, "verification.json"), JSON.stringify({ passed: true,
    transport: "Built console with isolated HTTP fixtures", cases: completed,
    unverified: ["live native forge transport", "PostHog", "webhook delivery", "model question checking"],
  }, null, 2));
  console.log(`PASS ${completed.length} connection browser scenarios; artifacts: ${artifacts}`);
} finally { await browser.close(); app.stop(); }
