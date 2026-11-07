// Fixture data for stories that render a component directly, with the same values the FakeApi serves.
import { summarize } from "../lib/usage.ts";
import { makeActivity, makeEvents, makeInbox, makeTrails, makeUsage, STORY_NOW } from "../fake/fixtures.ts";
import { makeRuns } from "../fake/runs.ts";

export const NOW = STORY_NOW;
export const trails = makeTrails(NOW);
export const inbox = makeInbox(trails, NOW);
export const activity = makeActivity(trails, NOW);
export const usageEntries = makeUsage(trails, NOW);
export const runs = makeRuns(trails, NOW);

const day = 86_400_000;
export const window14 = {
  from: new Date(Math.floor(NOW / day) * day - 13 * day).toISOString(), to: new Date(NOW).toISOString(),
};
const meta = trails.map((t) => ({ trailId: t.id, short: t.short, title: t.title, budget: {
  spendMicrousdUsed: t.budget.spendMicrousdUsed, spendMicrousdMax: t.budget.spendMicrousdMax,
  tokensUsed: t.budget.tokensUsed, tokensMax: t.budget.tokensMax } }));
export const usage14 = summarize(usageEntries, window14.from, window14.to, meta);
export const usage7 = summarize(usageEntries.filter((e) => e.at >= new Date(NOW - 6.5 * day).toISOString()),
  new Date(Math.floor(NOW / day) * day - 6 * day).toISOString(), window14.to, meta);

export const trailByShort = (hex: string) => trails.find((t) => t.short === `T-${hex}`)!;
export const trailId = (hex: string) => trailByShort(hex).id;
export const eventsFor = (hex: string) => makeEvents(trailByShort(hex), NOW);
