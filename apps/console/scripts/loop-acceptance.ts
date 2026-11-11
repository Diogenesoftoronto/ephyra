/**
 * The loop view's acceptance contract, as a script. It only knows the data attributes in design/09-console-redesign.md §7,
 * so the same checks run against the design lab today and against the real console once it implements the view.
 *
 *   env -u LD_LIBRARY_PATH bun scripts/loop-acceptance.ts                      the lab (builds it first)
 *   env -u LD_LIBRARY_PATH bun scripts/loop-acceptance.ts --no-build
 *   env -u LD_LIBRARY_PATH bun scripts/loop-acceptance.ts --target=console --url=http://127.0.0.1:4317/app/#/loop
 *
 * A check that needs a quest in a state the page does not have (nothing recovering, nobody asked) is reported as SKIP.
 * Skips fail the run unless --allow-skips is given: an unexercised promise is not a kept one.
 * `scripts/e2e-loop.ts` imports `runAcceptance` and points it at a console backed by a real server.
 */
import { $ } from "bun";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { ATTENTION, ATTENTION_GROUP, ATTENTION_LABEL, STAGE_IDS, type Attention } from "../src/loop/model.ts";
import { HOOD_TABS } from "../src/loop/Inspector.tsx";
import { launch, serve } from "./browser.ts";

export type Target = "lab" | "console";
export interface Outcome { id: string; promise: string; status: "pass" | "fail" | "skip"; detail: string }
export interface AcceptanceOptions {
  target: Target;
  /** The loop view. Query parameters are kept; the lab adds its own. */
  url: string;
  browser: Browser;
  /** Called before each check that changes state (approving), so a real server can be reseeded. */
  reset?: () => Promise<void>;
}

class Skip extends Error {}
const skip = (why: string): never => { throw new Skip(why); };
const must = (ok: unknown, why: string): void => { if (!ok) throw new Error(why); };

interface Seen { short: string; stage: string; attention: string; words: boolean; retreats: number }

/** Every quest the page shows, with the stage and attention it claims. Runs in the page. */
async function quests(page: Page): Promise<Seen[]> {
  const labels = ATTENTION_LABEL as Record<string, string>;
  const found = await page.evaluate((known) => {
    const out: { short: string; stage: string; attention: string; words: boolean; retreats: number }[] = [];
    for (const el of document.querySelectorAll("[data-quest]")) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const attention = el.getAttribute("data-attention") ?? "";
      const spoken = `${el.textContent ?? ""} ${[...el.querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label")).join(" ")}`;
      out.push({
        short: el.getAttribute("data-quest") ?? "", stage: el.getAttribute("data-stage") ?? "", attention,
        retreats: Number(el.getAttribute("data-retreats") ?? 0),
        words: spoken.toLowerCase().includes((known[attention] ?? "\u0000").toLowerCase()),
      });
    }
    return out;
  }, labels);
  const byShort = new Map<string, Seen>();
  for (const quest of found) {
    const prior = byShort.get(quest.short);
    if (prior && (prior.stage !== quest.stage || prior.attention !== quest.attention)) {
      throw new Error(`${quest.short} is drawn twice and disagrees with itself: ${prior.stage}/${prior.attention} and ${quest.stage}/${quest.attention}`);
    }
    byShort.set(quest.short, { ...quest, words: quest.words || (prior?.words ?? false), retreats: Math.max(quest.retreats, prior?.retreats ?? 0) });
  }
  return [...byShort.values()];
}

async function select(page: Page, short: string): Promise<void> {
  await page.locator(`[data-quest="${short}"]`).locator("button, a").first().click();
  await page.waitForSelector(`[data-detail="${short}"]`, { timeout: 3_000 });
}

async function withState(page: Page, attention: Attention): Promise<Seen> {
  const quest = (await quests(page)).find((entry) => entry.attention === attention);
  if (!quest) skip(`no quest is ${ATTENTION_LABEL[attention].toLowerCase()} on this page`);
  await select(page, quest!.short);
  return quest!;
}

/** The count a group shows in the fleet sentence. A group that is not mentioned counts as zero. */
const fleetCount = (page: Page, group: string): Promise<number> => page.evaluate((name) => {
  const part = document.querySelector(`[data-loop-fleet] [data-group="${name}"]`);
  return Number(part?.textContent?.match(/\d+/)?.[0] ?? 0);
}, group);

interface Check { id: string; promise: string; only?: Target; phone?: boolean; mutates?: boolean; run: (page: Page, target: Target) => Promise<string> }

const CHECKS: Check[] = [
  {
    id: "fleet-sentence", promise: "One sentence says what the software is doing by itself and whether you are needed",
    async run(page) {
      const fleet = page.locator("[data-loop-fleet]");
      must(await fleet.count() === 1, "there must be exactly one [data-loop-fleet]");
      must(await page.locator("h1").count() === 1 && await fleet.evaluate((el) => el.tagName === "H1"), "the fleet sentence is the page's only h1");
      const box = await fleet.boundingBox();
      must(box && box.y >= 0 && box.y + box.height <= page.viewportSize()!.height, "the fleet sentence sits in the first viewport");
      const seen = await quests(page);
      for (const group of ["self", "you", "stopped"] as const) {
        const want = seen.filter((quest) => ATTENTION_GROUP[quest.attention as Attention] === group).length;
        const got = await fleetCount(page, group);
        must(got === want, `the sentence says ${got} for "${group}" but the page shows ${want}`);
      }
      return (await fleet.innerText()).replace(/\s+/g, " ").trim();
    },
  },
  {
    id: "quest-state", promise: "Every quest shows its stage and its status, and the status is said in words, not only in colour",
    async run(page) {
      const seen = await quests(page);
      if (seen.length === 0) skip("no quests on this page");
      for (const quest of seen) {
        must((STAGE_IDS as readonly string[]).includes(quest.stage), `${quest.short} has an unknown data-stage "${quest.stage}"`);
        must((ATTENTION as readonly string[]).includes(quest.attention), `${quest.short} has an unknown data-attention "${quest.attention}"`);
        must(quest.words, `${quest.short} never says "${ATTENTION_LABEL[quest.attention as Attention]}" in text or an aria-label`);
      }
      return `${seen.length} quests: ${seen.map((quest) => `${quest.short} ${quest.stage}/${quest.attention}`).join(", ")}`;
    },
  },
  {
    id: "one-loud-action", promise: "At most one primary action, docked where you can see it without scrolling",
    async run(page) {
      const waiting = (await quests(page)).filter((quest) => quest.attention === "needs_you");
      const primary = page.locator("[data-primary]:visible");
      const count = await primary.count();
      if (waiting.length === 0) {
        must(count === 0, `nothing needs you, yet ${count} primary action(s) are on the page`);
        return "nothing needs you, and nothing shouts";
      }
      must(count === 1, `${count} primary actions are visible; the rule is one`);
      must(await page.locator("[data-needs-you] [data-primary]").count() === 1, "the primary action lives inside [data-needs-you]");
      const box = (await primary.boundingBox())!;
      const view = page.viewportSize()!;
      must(box.y >= 0 && box.y + box.height <= view.height, `the primary action is at y=${Math.round(box.y)}, below the first ${view.height}px`);
      must(Math.min(box.width, box.height) >= 36, `the primary action is ${Math.round(box.width)}×${Math.round(box.height)}px; it needs at least 36`);
      return `"${(await primary.innerText()).replace(/\s+/g, " ").trim()}" at y=${Math.round(box.y)}`;
    },
  },
  {
    id: "select", promise: "Picking a quest shows that quest, in the same state, beside the list; j and k walk the list",
    async run(page) {
      const seen = await quests(page);
      if (seen.length < 2) skip("fewer than two quests on this page");
      const pick = seen.at(-1)!;
      await select(page, pick.short);
      const detail = page.locator(`[data-detail="${pick.short}"]`);
      must(await detail.getAttribute("data-stage") === pick.stage, "the detail's stage differs from the row's");
      must(await detail.getAttribute("data-attention") === pick.attention, "the detail's status differs from the row's");
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      await page.keyboard.press("j");
      await page.waitForFunction((was) => document.querySelector("[data-detail]")?.getAttribute("data-detail") !== was, pick.short, { timeout: 2_000 });
      const next = await page.locator("[data-detail]").getAttribute("data-detail");
      await page.keyboard.press("k");
      await page.waitForSelector(`[data-detail="${pick.short}"]`, { timeout: 2_000 });
      return `${pick.short} → j → ${next} → k → ${pick.short}`;
    },
  },
  {
    id: "recovery", promise: "A quest that got stuck shows each thing it tried, what that ran into, and the different thing it is trying now",
    async run(page) {
      const quest = await withState(page, "recovering");
      const rungs = page.locator(`[data-detail="${quest.short}"] [data-attempts] li[data-strategy]`);
      const strategies = await rungs.evaluateAll((items) => items.map((item) => ({
        strategy: item.getAttribute("data-strategy"), current: item.hasAttribute("data-current"), text: (item.textContent ?? "").trim(),
      })));
      must(strategies.length >= 2, `a recovering quest shows ${strategies.length} attempt(s); recovery needs at least two`);
      must(strategies.filter((rung) => rung.current).length === 1, "exactly one attempt is the current one");
      const at = strategies.findIndex((rung) => rung.current);
      must(at > 0 && strategies[at]!.strategy !== strategies[at - 1]!.strategy, "the current attempt uses the same strategy as the one that just failed");
      must(strategies.every((rung) => rung.text.length > 12), "every attempt says what it is or what it ran into");
      return `${quest.short}: ${strategies.map((rung) => `${rung.strategy}${rung.current ? " (now)" : ""}`).join(" → ")}`;
    },
  },
  {
    id: "question", promise: "When it asks a person, you can read the question, who it went to, and that it was checked first",
    async run(page) {
      const quest = await withState(page, "asking");
      const card = page.locator(`[data-detail="${quest.short}"] [data-question]`);
      must(await card.count() === 1, "an asking quest shows one [data-question]");
      must(Boolean(await card.getAttribute("data-status")), "the question carries its status");
      must((await card.innerText()).trim().length > 40, "the question text is on the page");
      must(await card.locator("[data-check]").count() >= 1, "the question shows the check it passed before it was sent");
      return `${quest.short}: ${await card.getAttribute("data-status")}, ${await card.locator("[data-check]").count()} check(s)`;
    },
  },
  {
    id: "retreat", promise: "Going backwards is visible as going backwards: a failed proof or a rollback draws as a second descent",
    async run(page) {
      const sank = (await quests(page)).filter((entry) => entry.retreats > 0);
      if (sank.length === 0) skip("no quest on this page has gone backwards yet");
      const told: string[] = [];
      for (const quest of sank) {
        await select(page, quest.short);
        const path = page.locator(`[data-detail="${quest.short}"] [data-path]`);
        must(await path.count() === 1, `${quest.short} has no [data-path] in its detail`);
        const drawn = Number(await path.getAttribute("data-retreats"));
        must(drawn === quest.retreats, `${quest.short}: the row says it sank back ${quest.retreats}× but its path draws ${drawn}`);
        must(await path.locator('[data-kind="retreat"]').count() >= drawn, `${quest.short}: the path has no [data-kind="retreat"] marks`);
        told.push(`${quest.short} ${drawn}×`);
      }
      return told.join(", ");
    },
  },
  {
    id: "under-the-hood", promise: "One key opens the machinery: events, effects with their idempotency keys, attempts, questions, runs, receipts",
    async run(page) {
      const seen = await quests(page);
      if (seen.length === 0) skip("no quests on this page");
      const pick = seen.find((quest) => quest.attention === "recovering") ?? seen[0]!;
      await select(page, pick.short);
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      await page.keyboard.press("i");
      const hood = page.locator("[data-inspector]");
      await hood.waitFor({ timeout: 3_000 });
      const tabs = await hood.locator("[data-tab]").evaluateAll((items) => items.map((item) => item.getAttribute("data-tab")));
      must(HOOD_TABS.every((tab) => tabs.includes(tab)), `the hood has tabs ${tabs.join(", ")}; it needs ${HOOD_TABS.join(", ")}`);
      await hood.locator('[data-tab="events"]').click();
      must(await hood.locator("[data-hood-events] > li").count() >= 1, "the events tab lists the quest's events");
      await hood.locator('[data-tab="effects"]').click();
      const effects = await hood.locator("[data-hood-effects] > li").count();
      const keys = await hood.locator("[data-hood-effects] [data-idempotency-key]").allInnerTexts();
      must(effects >= 1 && keys.length === effects, `${effects} effects but ${keys.length} idempotency keys`);
      must(new Set(keys).size === keys.length && keys.every((key) => key.trim().length > 8), "every effect has its own key");
      await hood.locator('[data-tab="effects"]').focus();
      await page.keyboard.press("ArrowRight");
      must(await hood.locator('[data-tab][aria-selected="true"]').getAttribute("data-tab") === "attempts", "→ moves to the next tab");
      await page.keyboard.press("Escape");
      await hood.waitFor({ state: "detached", timeout: 3_000 });
      must(await page.evaluate(() => document.activeElement?.hasAttribute("data-open-hood") ?? false), "closing the hood returns focus to the control that opens it");
      return `${pick.short}: ${effects} effects, each with its own key`;
    },
  },
  {
    id: "approve", promise: "Approving is two deliberate keys, it answers at once, and the quest moves on by itself",
    mutates: true,
    async run(page) {
      const strip = page.locator("[data-needs-you]");
      if (await strip.count() === 0) skip("nothing needs you on this page");
      const short = (await strip.getAttribute("data-needs-you"))!;
      const before = await fleetCount(page, "you");
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(250);
      must(await page.locator(`[data-needs-you="${short}"]`).count() === 1, "a stray Enter approved a landing; approving takes focus first");
      await page.keyboard.press("a");
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-primary") ?? false, undefined, { timeout: 2_000 });
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement!);
        return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
      });
      must(ring, "the focused primary action has no visible focus ring");
      await page.keyboard.press("Enter");
      await page.waitForFunction((was) => document.querySelector(`[data-needs-you="${was}"]`) === null, short, { timeout: 5_000 });
      const toast = page.locator("[data-toast]");
      must((await toast.innerText()).trim().length > 0, "nothing announced the decision");
      must(await toast.getAttribute("role") === "status", "the announcement is a polite status, not a silent div");
      const after = (await quests(page)).find((quest) => quest.short === short);
      must(after && after.attention !== "needs_you", `${short} still says it needs you`);
      must(await fleetCount(page, "you") === before - 1, "the fleet sentence did not change");
      return `${short}: ${(await toast.innerText()).trim()}`;
    },
  },
  {
    id: "calm", promise: "With reduced motion nothing loops and nothing takes longer than a blink",
    async run(page) {
      const moving = await page.evaluate(() => document.getAnimations().map((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return { loops: timing?.iterations === Infinity, ms: Number(timing?.duration ?? 0) };
      }).filter((entry) => entry.loops || entry.ms > 200));
      must(moving.length === 0, `${moving.length} animation(s) still loop or run past 200 ms under reduced motion`);
      return "no loops, nothing over 200 ms";
    },
  },
  {
    id: "phone", promise: "On a phone: no sideways scroll, the action is on the first screen, every target is at least 24 px",
    phone: true,
    async run(page) {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      must(over <= 1, `the page scrolls sideways by ${over}px`);
      const primary = page.locator("[data-primary]:visible");
      if (await primary.count()) {
        const box = (await primary.boundingBox())!;
        must(box.y + box.height <= page.viewportSize()!.height, `the primary action is at y=${Math.round(box.y)}, off the first screen`);
      }
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll("a[href], button, [role='tab'], input, select, textarea, summary")) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1 || getComputedStyle(el).visibility === "hidden") continue;
          let size = Math.min(rect.width, rect.height);
          for (const pseudo of ["::before", "::after"]) {
            const style = getComputedStyle(el, pseudo);
            if (style.content === "none" || style.position !== "absolute") continue;
            size = Math.max(size, Math.min(parseFloat(style.width) || 0, parseFloat(style.height) || 0));
          }
          if (size < 24) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(size)}px`);
        }
        return out;
      });
      must(small.length === 0, `targets under 24px: ${small.slice(0, 4).join("; ")}`);
      return "fits, reachable, tappable";
    },
  },
  {
    id: "honest-label", promise: "A simulation says it is one; the real console never wears that label",
    async run(page, target) {
      const label = page.locator("[data-sim-label]:visible");
      if (target === "lab") {
        must(await label.count() === 1, "the lab must say its quests are simulated");
        return (await label.innerText()).trim();
      }
      must(await label.count() === 0, "the console shows a simulation label on real quests");
      return "no simulation label";
    },
  },
  {
    id: "replay", promise: "The hour can be replayed: a link opens any moment, and stepping moves time",
    only: "lab",
    async run(page) {
      const slider = page.locator("[data-transport] input[type=range]");
      const at = Number(await slider.inputValue());
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      await page.keyboard.press("]");
      await page.waitForFunction((was) => Number(document.querySelector<HTMLInputElement>("[data-transport] input")?.value) === was + 1, at, { timeout: 2_000 });
      await page.keyboard.press("}");
      await page.waitForFunction((was) => Number(document.querySelector<HTMLInputElement>("[data-transport] input")?.value) > was + 1, at, { timeout: 2_000 });
      const link = (set: Record<string, string>) => {
        const url = new URL(page.url());
        for (const [key, value] of Object.entries(set)) url.searchParams.set(key, value);
        return url.toString();
      };
      const open = async (to: string) => {
        await page.goto("about:blank");
        await page.goto(to);
        await page.waitForSelector("[data-loop-fleet]");
      };
      const start = link({ t: "0" });
      const now = await quests(page);
      const asked = now.find((quest) => quest.attention === "asking") ?? now[0]!;
      const later = link({ t: String(at), q: asked.short });
      await open(start);
      const first = await quests(page);
      must(first.length < now.length, "the first minute already holds every quest of the hour");
      must(first.every((quest) => quest.retreats === 0 && quest.attention === "self"), "in the first minute a quest is already stuck or sent back");
      must(await page.locator("[data-primary]:visible").count() === 0, "at t=0 nothing can need you yet");
      await open(later);
      must(Number(await page.locator("[data-transport] input[type=range]").inputValue()) === at, "the link did not restore the moment");
      must(await page.locator(`[data-detail="${asked.short}"]`).count() === 1, "the link did not restore the selected quest");
      return `stepped from ${at}; t=0 shows ${first.length} fresh quest(s); a link reopens ${asked.short} at ${at}`;
    },
  },
];

export const CRITERIA = CHECKS.map(({ id, promise, only }) => ({ id, promise, only: only ?? "both" }));

/** Runs every check in a fresh page, so one failure cannot poison the next. */
export async function runAcceptance(options: AcceptanceOptions): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const check of CHECKS) {
    if (check.only && check.only !== options.target) continue;
    if (check.mutates) await options.reset?.();
    const context = await options.browser.newContext({
      viewport: check.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    let outcome: Outcome;
    try {
      await page.goto(options.url);
      await page.waitForSelector("[data-loop-fleet]", { timeout: 15_000 });
      await page.evaluate(async () => { await document.fonts.ready; });
      const detail = await check.run(page, options.target);
      if (errors.length) throw new Error(`the page logged errors: ${errors.slice(0, 3).join(" | ")}`);
      outcome = { id: check.id, promise: check.promise, status: "pass", detail };
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      outcome = { id: check.id, promise: check.promise, status: error instanceof Skip ? "skip" : "fail", detail };
    }
    outcomes.push(outcome);
    await context.close();
  }
  return outcomes;
}

export function report(outcomes: readonly Outcome[]): void {
  const mark = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;
  for (const outcome of outcomes) {
    console.log(`${mark[outcome.status]}  ${outcome.id.padEnd(16)} ${outcome.promise}`);
    console.log(`      ${"".padEnd(16)} ${outcome.detail}`);
  }
  const count = (status: Outcome["status"]) => outcomes.filter((outcome) => outcome.status === status).length;
  console.log(`\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped of ${outcomes.length}.`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const target = (flag("target") ?? "lab") as Target;
  const root = join(import.meta.dir, "..");
  let url = flag("url");
  let stop = () => {};
  if (target === "lab" && !url) {
    if (!args.includes("--no-build")) {
      const build = await $`bun run build:lab`.cwd(root).quiet().nothrow();
      if (build.exitCode !== 0) { console.error(build.stderr.toString() || build.stdout.toString()); process.exit(1); }
    }
    const server = serve(join(root, "dist-lab"), "/app/");
    stop = server.stop;
    url = `${server.url}/app/lab.html?motion=reduced&theme=light#/layouts/${flag("layout") ?? "h"}`;
  }
  if (!url) { console.error("--target=console needs --url=<the loop view>"); process.exit(2); }
  const browser = await launch();
  let outcomes: Outcome[] = [];
  try {
    outcomes = await runAcceptance({ target, url, browser });
  } finally {
    await browser.close();
    stop();
  }
  report(outcomes);
  const failed = outcomes.some((outcome) => outcome.status === "fail" || (outcome.status === "skip" && !args.includes("--allow-skips")));
  process.exit(failed ? 1 : 0);
}
