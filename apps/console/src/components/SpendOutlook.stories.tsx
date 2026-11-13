import type { Meta, StoryObj } from "@storybook/react-vite";
import type { UsageSummary } from "@ephyra/core";
import { STORY_NOW } from "../fake/fixtures.ts";
import { SpendOutlook } from "./SpendOutlook.tsx";

/** Fictional daily spend; the projection is arithmetic on these numbers only. */
const meta: Meta = { title: "Usage/Spend outlook" };
export default meta;
const DAY = 86_400_000;
const today = new Date(STORY_NOW).toISOString().slice(0, 10);
const days = (n: number): UsageSummary["byDay"] => Array.from({ length: n + 1 }, (_, i) => ({
  key: new Date(STORY_NOW - (n - i) * DAY).toISOString().slice(0, 10),
  totals: { entries: 12, tokens: 0, costMicrousd: 2_400_000 + ((i * 37) % 11) * 260_000, wallMs: 0,
    unknownCost: i % 9 === 0 ? 1 : 0, failed: 0, unavailable: 0 },
}));
export const Quarter: StoryObj = { render: () => <SpendOutlook days={days(90)} today={today} /> };
export const NotEnoughHistory: StoryObj = { render: () => <SpendOutlook days={days(4)} today={today} /> };
