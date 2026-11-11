import { expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PAGES } from "../app/route.ts";
import { HELP, agentBrief, dismissTip, dismissedTips, docsUrl, nextTip, publicRepository, setTipsOff, tipsOff } from "./help.ts";

const pagesDir = join(import.meta.dir, "../../../web/content/docs/pages");
const slugs = readdirSync(pagesDir).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3));
/** GitHub-style heading ids, as the docs renderer produces them. */
const anchors = (slug: string) => [...readFileSync(join(pagesDir, `${slug}.md`), "utf8").matchAll(/^#{2,3} (.+)$/gm)]
  .map((match) => match[1]!.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-"));
const memory = () => { const map = new Map<string, string>(); return {
  getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value),
  removeItem: (key: string) => void map.delete(key) }; };

test("every screen has help, and every link it offers names a published page and a heading on it", () => {
  const ids = new Set<string>();
  for (const page of PAGES) {
    const help = HELP[page];
    expect(help.about.length, page).toBeGreaterThan(30);
    expect(help.tips.length, page).toBeGreaterThan(0);
    for (const target of [help.docs, ...help.tips.map((tip) => tip.docs).filter((docs): docs is string => Boolean(docs))]) {
      const [slug, anchor] = target.split("#");
      expect(slugs, `${page} → ${target}`).toContain(slug!);
      if (anchor) expect(anchors(slug!), `${page} → ${target}`).toContain(anchor);
    }
    for (const tip of help.tips) {
      expect(ids.has(tip.id), tip.id).toBe(false);
      ids.add(tip.id);
      expect(tip.text.length, tip.id).toBeLessThan(190);
    }
  }
  expect(docsUrl("index")).toBe("https://ephyra.quest/docs");
  expect(docsUrl("policy")).toBe("https://ephyra.quest/docs/policy");
});

test("tips are shown in order, one at a time, until dismissed or turned off", () => {
  const store = memory();
  expect(nextTip("inbox", dismissedTips(store), tipsOff(store))?.id).toBe("inbox-evidence");
  dismissTip("inbox-evidence", store);
  dismissTip("inbox-evidence", store);
  expect(dismissedTips(store)).toEqual(["inbox-evidence"]);
  expect(nextTip("inbox", dismissedTips(store), tipsOff(store))?.id).toBe("inbox-bound");
  for (const tip of HELP.inbox.tips) dismissTip(tip.id, store);
  expect(nextTip("inbox", dismissedTips(store), tipsOff(store))).toBeUndefined();
  setTipsOff(true, store);
  expect(nextTip("usage", dismissedTips(store), tipsOff(store))).toBeUndefined();
  // Turning tips back on starts them again.
  setTipsOff(false, store);
  expect(nextTip("inbox", dismissedTips(store), tipsOff(store))?.id).toBe("inbox-evidence");
  // Blocked or corrupt storage never throws.
  expect(dismissedTips({ getItem: () => "{not json", setItem() {}, removeItem() {} })).toEqual([]);
  expect(dismissedTips({ getItem: () => { throw new Error("blocked"); }, setItem() {}, removeItem() {} })).toEqual([]);
  expect(() => dismissTip("x", null)).not.toThrow();
});

test("the agent brief names where things are and never carries a credential", () => {
  const brief = agentBrief({ server: "https://console.example", repository: "https://user:s3cret-token@git.example/team/app.git?token=abc", branch: "main", page: "onboarding", setupStatus: "blocked" });
  expect(brief).toContain("https://ephyra.quest/docs/agent.md");
  expect(brief).toContain("https://console.example/auth.md");
  expect(brief).toContain("https://git.example/team/app.git, branch main");
  expect(brief).toContain("Setup: blocked");
  expect(brief).toContain("https://ephyra.quest/docs/quickstart.md");
  expect(brief).toContain("Report only checks and observations that actually happened");
  expect(brief).not.toContain("s3cret-token");
  expect(brief).not.toContain("token=abc");
  const demo = agentBrief({ server: "https://console.example", page: "loop", demo: true });
  expect(demo).not.toContain("/auth.md");
  expect(demo).toContain("Repository: not connected yet");
  fc.assert(fc.property(fc.webUrl(), fc.string({ minLength: 6, maxLength: 30 }).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)), (url, secret) => {
    const u = new URL(url); u.username = "bot"; u.password = secret;
    const cleaned = publicRepository(u.href);
    expect(cleaned === null || !cleaned.includes(`:${secret}@`)).toBe(true);
    expect(agentBrief({ server: "https://c.example", repository: u.href, page: "settings" })).not.toContain(`:${secret}@`);
  }));
  expect(publicRepository("not a url")).toBeNull();
});
