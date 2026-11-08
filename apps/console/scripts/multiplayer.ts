// Real HTTP, engine and git-journal browser check with explicitly fictional sessions and sample trails.
// No provider, hosted account, forge push or cloud calls. Build the console before running this script.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { Trail, TrailEvent } from "@ephyra/core";
import { compose, type Composed } from "../../server/src/compose.ts";
import { readConfig } from "../../server/src/config.ts";
import { createApp } from "../../server/src/http/app.ts";
import { consoleStatic } from "../../server/src/http/static.ts";
import { httpPort } from "../../server/src/wiring/human.ts";
import { makeTrails } from "../src/fake/fixtures.ts";
import { launch } from "./browser.ts";

const root = join(import.meta.dir, "..");
const artifacts = join(root, "artifacts/multiplayer");
const SERVICE = "local-browser-check-service-token";
const SESSIONS = {
  "fixture-reviewer-a": "did:example:reviewer-a",
  "fixture-reviewer-b": "did:example:reviewer-b",
  "fixture-reader": "did:example:reader",
} as const;
type Session = keyof typeof SESSIONS;
const aToken: Session = "fixture-reviewer-a";
const bToken: Session = "fixture-reviewer-b";
const readerToken: Session = "fixture-reader";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const identity = {
    GIT_AUTHOR_NAME: "Browser fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Browser fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const process = Bun.spawn(["git", ...args], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, ...identity },
  });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  assert.equal(code, 0, `temporary git fixture failed: ${err}`);
  return out.trim();
}

async function seed(server: Composed, sha: string): Promise<Trail> {
  const now = new Date().toISOString();
  const template = makeTrails(Date.now()).find((trail) => trail.state === "hypothesised")!;
  const trail = Trail.parse({
    ...template, title: "Sample multiplayer review: coupon applied twice", repo: "browser-fixture",
    base: { ref: "refs/heads/main", sha }, createdAt: now, updatedAt: now,
  });
  const initial = TrailEvent.parse({
    schema: 1, id: server.ctx.ids.uuidv7(), trail: trail.id, rev: trail.rev, at: now,
    actor: { kind: "system", id: "browser-fixture" }, type: "trail_created",
    data: { signalId: trail.signals[0], title: trail.title, baseRef: trail.base.ref, baseSha: sha },
  });
  await server.ctx.start(trail, initial);
  const snapshot = await server.ctx.journal.read(trail.id);
  assert.ok(snapshot);
  await server.ctx.journal.append(trail.id, snapshot.head, trail, [], {
    "hypothesis.md": new TextEncoder().encode("# Sample hypothesis\n\nThe coupon path can apply a discount twice.\n"),
  });
  await server.ctx.inbox.put({
    id: `${trail.id}:A`, trailId: trail.id, short: trail.short, title: trail.title, area: trail.area,
    risk: trail.risk, severity: trail.severity, state: trail.state, bound: { rev: trail.rev },
    kind: "checkpoint", checkpoint: "A", blocking: true, createdAt: now,
    artefact: { path: "hypothesis.md", summary: "Sample checkpoint: inspect the coupon hypothesis." },
  });
  return trail;
}

// Fixture setup only: replace a review revision without pretending an agent ran or proof passed.
// Persist the new document and bound revision, then refresh the API projection using the existing
// initial event (deduplicated by the store). The browser still reads only real HTTP responses.
async function advanceReviewFixture(server: Composed, id: string): Promise<{ trail: Trail; document: string }> {
  const before = await server.ctx.journal.read(id);
  const item = await server.ctx.inbox.get(`${id}:A`);
  assert.ok(before && item);
  const trail = Trail.parse({ ...before.trail, rev: before.trail.rev + 1, updatedAt: new Date().toISOString() });
  const document = `# Updated sample hypothesis\n\nExplicit browser fixture revision ${trail.rev}: inspect receipt rounding before approval.\n`;
  await server.ctx.journal.append(id, before.head, trail, [], {
    "hypothesis.md": new TextEncoder().encode(document),
  });
  await server.ctx.start(trail, before.events[0]!);
  await server.ctx.inbox.put({ ...item, bound: { rev: trail.rev } });
  return { trail, document };
}

const dir = await mkdtemp(join(tmpdir(), "ephyra-multiplayer-browser-"));
let composed: Composed | undefined;
let http: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
const pages: Page[] = [];
try {
  await mkdir(artifacts, { recursive: true });
  const origin = join(dir, "origin");
  await mkdir(origin);
  await git(origin, "init", "-q", "-b", "main");
  await writeFile(join(origin, "README.md"), "# Fictional local multiplayer browser fixture\n");
  await git(origin, "add", "README.md");
  await git(origin, "commit", "-q", "-m", "seed local browser fixture");
  const sha = await git(origin, "rev-parse", "HEAD");
  composed = await compose(readConfig({
    EPHYRA_API_TOKEN: SERVICE, EPHYRA_DATA_DIR: join(dir, "data"),
    EPHYRA_REPO_ID: "browser-fixture", EPHYRA_REPO_URL: origin,
    EPHYRA_AGENT: "none", EPHYRA_DECIDE: "none", EPHYRA_DRAFT: "none",
    EPHYRA_CONSOLE_DIR: join(root, "dist"),
  }), { startJobs: false });
  const server = composed;
  const trail = await seed(server, sha);
  const port = httpPort(server.ctx, { append: async (input) => server.memoryAudit.append(input) });
  const app = createApp(SERVICE, port, undefined, async (token) => {
    const did = Object.hasOwn(SESSIONS, token) ? SESSIONS[token as Session] : undefined;
    return did ? { did } : null;
  }, { requireSignIn: true, approvers: new Set([SESSIONS[aToken], SESSIONS[bToken]]) });
  // The selected trail also shows runs. Read the composed run store; no API response is mocked.
  app.get("/v1/runs", async (c) => c.json(await server.runs.list({ trail: c.req.query("trail"), limit: 50 })));
  app.route("/", consoleStatic(join(root, "dist")));
  http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const base = `http://127.0.0.1:${http.port}`;
  const endpoint = `${base}/v1/trails/${trail.id}`;
  const write = (token: Session, action: string, body: unknown = {}, key = crypto.randomUUID()) => fetch(`${endpoint}/${action}`, {
    method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key,
      "X-Ephyra-Principal": "spoofed-principal-must-not-be-used",
    }, body: JSON.stringify(body),
  });
  const journalComments = async (text: string) => (await server.ctx.journal.read(trail.id))!.events
    .filter((event) => event.type === "human_comment" && event.data.text === text);

  browser = await launch();
  const errors: string[] = [];
  async function session(token: Session, width = 1440): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser!.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce", colorScheme: "light" });
    await context.route("**/*", (route) => new URL(route.request().url()).origin === base
      ? route.continue() : route.abort("blockedbyclient"));
    await context.addInitScript(({ token }) => {
      sessionStorage.setItem("ephyra.connection", JSON.stringify({ token }));
      localStorage.setItem("ephyra.theme", "light");
    }, { token });
    const page = await context.newPage();
    pages.push(page);
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/app/#/inbox/${trail.id}`);
    await page.getByRole("heading", { name: "Discussion", exact: true }).waitFor();
    await page.getByText("Shared updates connected", { exact: true }).waitFor();
    return { context, page };
  }
  const { page: a } = await session(aToken);
  const { page: b } = await session(bToken);
  const discussion = (page: Page) => page.getByRole("region", { name: "Shared quest discussion", exact: true });
  const draft = (page: Page) => page.getByLabel("Comment on this quest", { exact: true });
  const message = (page: Page, text: string) => discussion(page).getByText(text, { exact: true });
  const post = async (page: Page, text: string) => {
    await draft(page).fill(text);
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await message(page, text).waitFor();
  };
  const holdDraft = async () => {
    await draft(b).fill("Keep my unfinished review note.");
    await draft(b).focus();
    await draft(b).evaluate((field) => {
      const input = field as HTMLTextAreaElement;
      input.setSelectionRange(5, 12);
      (window as unknown as { heldDraft: HTMLTextAreaElement }).heldDraft = input;
    });
  };
  const preservedDraft = async (label: string) => {
    const state = await draft(b).evaluate((field) => {
      const input = field as HTMLTextAreaElement;
      return {
        same: input === (window as unknown as { heldDraft: HTMLTextAreaElement }).heldDraft,
        focused: document.activeElement === input, value: input.value, start: input.selectionStart, end: input.selectionEnd,
      };
    });
    assert.deepEqual(state, {
      same: true, focused: true, value: "Keep my unfinished review note.", start: 5, end: 12,
    }, label);
  };

  await holdDraft();
  const first = "Please preserve receipt rounding. This is a shared browser-check comment.";
  await post(a, first);
  await message(b, first).waitFor();
  assert.equal(await message(b, first).locator("..").locator("header b").textContent(), SESSIONS[aToken]);
  await preservedDraft("incoming comment preserves draft node, focus and caret");
  assert.equal((await journalComments(first)).length, 1);
  console.log("PASS authenticated comment shared across independent browser contexts");

  await a.getByRole("button", { name: "Claim review", exact: true }).click();
  await a.getByRole("button", { name: "Release review", exact: true }).waitFor();
  await b.getByText("Review claimed", { exact: false }).waitFor();
  assert.ok(await b.getByRole("button", { name: "Claim review", exact: true }).isDisabled());
  assert.ok(await b.getByRole("button", { name: "Approve hypothesis", exact: true }).isDisabled());
  await preservedDraft("incoming claim preserves draft node, focus and caret");
  assert.equal((await write(bToken, "claim")).status, 409, "second reviewer cannot steal ownership");
  assert.equal((await write(bToken, "release")).status, 409, "second reviewer cannot release ownership");
  assert.equal((await server.ctx.trails.get(trail.id))!.owner?.id, SESSIONS[aToken]);
  await a.getByRole("button", { name: "Release review", exact: true }).click();
  await b.getByText("No reviewer has claimed this quest.", { exact: true }).waitFor();
  await preservedDraft("incoming release preserves draft node, focus and caret");
  assert.ok(await b.getByRole("button", { name: "Claim review", exact: true }).isEnabled());
  console.log("PASS exclusive review ownership and server refusal of wrong-owner writes");

  const { page: reader } = await session(readerToken, 375);
  assert.ok(await draft(reader).isDisabled());
  assert.ok(await reader.getByRole("button", { name: "Claim review", exact: true }).isDisabled());
  assert.ok(await reader.getByRole("button", { name: "Approve hypothesis", exact: true }).isDisabled());
  assert.equal((await write(readerToken, "comment", { text: "reader write must fail" })).status, 403);
  assert.equal((await write(readerToken, "claim")).status, 403);
  console.log("PASS read-only identity cannot comment, claim or decide");

  // Only simulate the transport outage; successful requests still reach production HTTP handlers.
  await b.route(endpoint, (route) => route.request().method() === "GET" ? route.abort("failed") : route.continue());
  await b.getByText("Updates paused", { exact: true }).waitFor();
  await preservedDraft("read failure retains draft node, focus and caret");
  const duringOutage = "Added while the other reviewer was disconnected.";
  await post(a, duringOutage);
  await b.unroute(endpoint);
  await message(b, duringOutage).waitFor();
  await b.getByText("Shared updates connected", { exact: true }).waitFor();
  await preservedDraft("reconnect catches up without remounting the composer");
  console.log("PASS disconnected draft preservation and shared catch-up on reconnect");

  let dropped = false;
  let commentPosts = 0;
  let unknownKey = "";
  await a.route(`${endpoint}/comment`, async (route) => {
    commentPosts++;
    if (dropped) return route.continue();
    dropped = true;
    unknownKey = route.request().headers()["idempotency-key"] ?? "";
    const response = await route.fetch();
    assert.equal(response.status(), 200, "server records the comment before its answer is dropped");
    await route.abort("failed");
  });
  const ambiguous = "This comment was saved before the connection lost its reply.";
  await draft(a).fill(ambiguous);
  await a.getByRole("button", { name: "Add comment", exact: true }).click();
  await a.getByRole("button", { name: "Check delivery", exact: true }).waitFor();
  assert.ok(unknownKey, "unknown write keeps an operation key");
  assert.ok(await a.getByRole("button", { name: "Add comment", exact: true }).isDisabled());
  await message(b, ambiguous).waitFor();
  assert.equal((await journalComments(ambiguous)).length, 1);
  await a.getByRole("button", { name: "Check delivery", exact: true }).click();
  await a.getByRole("button", { name: "Check delivery", exact: true }).waitFor({ state: "hidden" });
  assert.equal(commentPosts, 1, "delivery check never reposts the mutation");
  assert.equal((await journalComments(ambiguous)).length, 1, "reconciliation leaves one durable comment");
  await a.unroute(`${endpoint}/comment`);
  console.log("PASS ambiguous successful write reconciles from durable receipt without duplication");

  const attempted: { key: string; body: unknown }[] = [];
  await a.route(`${endpoint}/comment`, async (route) => {
    attempted.push({ key: route.request().headers()["idempotency-key"] ?? "", body: route.request().postDataJSON() });
    // Unlike the previous case, the initial POST never reaches the server.
    if (attempted.length === 1) await route.abort("failed");
    else await route.continue();
  });
  const unsaved = "This saved intent must survive a connection failure before delivery.";
  const newerDraft = "A separate new draft typed while the previous change is unresolved.";
  await draft(a).fill(unsaved);
  await a.getByRole("button", { name: "Add comment", exact: true }).click();
  await a.getByRole("button", { name: "Check delivery", exact: true }).waitFor();
  assert.equal((await journalComments(unsaved)).length, 0, "dropped request was not saved");
  await draft(a).fill(newerDraft);
  const missingReceipt = a.waitForResponse((response) => response.url().startsWith(`${endpoint}/operations/comment?`));
  await a.getByRole("button", { name: "Check delivery", exact: true }).click();
  assert.deepEqual(await (await missingReceipt).json(), { status: "not_found" });
  await a.getByRole("button", { name: "Retry saved change", exact: true }).waitFor();
  assert.equal(attempted.length, 1, "receipt lookup does not implicitly replay an unsaved change");
  assert.ok(await a.getByRole("button", { name: "Add comment", exact: true }).isDisabled());
  await a.getByRole("button", { name: "Retry saved change", exact: true }).click();
  await message(b, unsaved).waitFor();
  await a.getByRole("button", { name: "Retry saved change", exact: true }).waitFor({ state: "hidden" });
  assert.equal(attempted.length, 2, "explicit retry sends exactly one additional POST");
  assert.ok(attempted[0]!.key, "original attempt has an operation key");
  assert.deepEqual(attempted[1], attempted[0], "retry preserves the exact original key and payload");
  assert.deepEqual(attempted[1]!.body, { text: unsaved });
  assert.equal((await journalComments(unsaved)).length, 1, "explicit retry records exactly one comment");
  assert.equal((await journalComments(newerDraft)).length, 0, "edited draft is never sent as the retry");
  assert.equal(await draft(a).inputValue(), newerDraft, "successful retry preserves the newer draft");
  await a.unroute(`${endpoint}/comment`);
  console.log("PASS lost-before-save recovery retries the original intent once and preserves the newer draft");

  const approve = a.getByRole("button", { name: "Approve hypothesis", exact: true });
  const boundRevision = a.locator('dl[aria-label="What this approval is bound to"] dd').first();
  assert.ok(await approve.isEnabled());
  const previousRevision = Number(await boundRevision.textContent());
  let decisionPosts = 0;
  a.on("request", (request) => {
    if (request.method() === "POST" && request.url() === `${endpoint}/decide`) decisionPosts++;
  });
  const updatedInbox = a.waitForResponse(async (response) => {
    if (response.url() !== `${base}/v1/inbox` || response.status() !== 200) return false;
    const entries = await response.json() as { trailId: string; bound: { rev: number } }[];
    return entries.some((entry) => entry.trailId === trail.id && entry.bound.rev === previousRevision + 1);
  });
  const advanced = await advanceReviewFixture(server, trail.id);
  await a.getByRole("region", { name: "Review evidence", exact: true }).getByText(advanced.document, { exact: true }).waitFor();
  await a.getByText("This approval is stale.", { exact: true }).waitFor();
  await updatedInbox;
  assert.equal(await a.locator(".trail-head-facts dd").first().textContent(), String(advanced.trail.rev), "quest revision updates automatically");
  assert.equal(await boundRevision.textContent(), String(previousRevision), "automatic updates retain the original review binding");
  assert.ok(await approve.isDisabled(), "stale approval remains disabled after new documents and inbox data arrive");
  await b.getByRole("region", { name: "Review evidence", exact: true }).getByText(advanced.document, { exact: true }).waitFor();
  await b.getByText("This approval is stale.", { exact: true }).waitFor();
  await preservedDraft("remote revision preserves the other reviewer's draft node, focus and caret");
  await a.getByRole("button", { name: "Reload this quest", exact: true }).click();
  await a.getByText("This approval is stale.", { exact: true }).waitFor({ state: "hidden" });
  await a.getByText("Shared updates connected", { exact: true }).waitFor();
  assert.equal(await boundRevision.textContent(), String(advanced.trail.rev), "explicit review reload adopts the current binding");
  assert.ok(await approve.isEnabled(), "explicit review reload enables a fresh decision");
  assert.equal(decisionPosts, 0, "review reload never submits a decision");
  assert.equal((await server.ctx.journal.read(trail.id))!.trail.checkpoints.A, undefined);
  console.log("PASS remote revision updates stay stale until explicit review reload, without submitting approval");

  await a.screenshot({ path: join(artifacts, "shared-review-desktop.png"), fullPage: true });
  await b.setViewportSize({ width: 375, height: 844 });
  await discussion(b).scrollIntoViewIfNeeded();
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "mobile page has no overflow");
  assert.ok(await discussion(b).evaluate((node) => node.scrollWidth <= node.clientWidth + 1), "mobile discussion has no overflow");
  await b.screenshot({ path: join(artifacts, "shared-review-mobile.png"), fullPage: true });
  await b.getByRole("switch", { name: "Dark mode", exact: true }).check();
  await discussion(b).scrollIntoViewIfNeeded();
  await b.screenshot({ path: join(artifacts, "shared-review-mobile-dark.png"), fullPage: true });
  assert.deepEqual(errors, [], "browser runtime errors");
  console.log("PASS mobile discussion layout and light/dark screenshots");
  await writeFile(join(artifacts, "verification.json"), JSON.stringify({
    passed: true, at: new Date().toISOString(), sessions: 3, transport: "real loopback HTTP",
    persistence: "production Engine and GitJournal, memory projection", identity: "fixture human session resolver",
    checks: ["shared comments and authors", "draft node/focus/caret preservation", "exclusive review ownership",
      "read-only refusal", "disconnect and catch-up", "durable ambiguous-write reconciliation",
      "explicit same-key retry preserves saved intent and newer draft", "stale review binding requires manual reload", "mobile layout"],
    unverified: ["hosted sign-in", "multiple server processes", "providers", "cloud and forge writes"],
  }, null, 2) + "\n");
  console.log(`Screenshots: ${artifacts}`);
  console.log("Verified with local fixture sessions; hosted sign-in and multiple server processes were not exercised.");
} catch (error) {
  for (const [index, page] of pages.entries()) {
    await page.screenshot({ path: join(artifacts, `failure-${index}.png`), fullPage: true }).catch(() => undefined);
    console.error(`Page ${index}:`, (await page.locator("body").innerText().catch(() => "unavailable")).slice(-3000));
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  http?.stop(true);
  await composed?.close();
  await rm(dir, { recursive: true, force: true });
}
