import type { Meta, StoryObj } from "@storybook/react-vite";
import { makeQuestHistory, STORY_NOW } from "../fake/fixtures.ts";
import { weeklyCost } from "../lib/quest-cost.ts";
import { QuestCost } from "./QuestCost.tsx";

/** Fictional quest history. Every landing has a fictional receipt; nothing here is a real deployment. */
const meta: Meta = { title: "Usage/Cost per landed quest" };
export default meta;
const history = makeQuestHistory(STORY_NOW);
export const GettingCheaper: StoryObj = { render: () => <QuestCost weeks={weeklyCost(history, STORY_NOW, 12)} /> };
export const TooFewWeeks: StoryObj = { render: () => <QuestCost weeks={weeklyCost(history.slice(0, 5), STORY_NOW, 12)} /> };
export const NothingLanded: StoryObj = { render: () => <QuestCost weeks={weeklyCost([], STORY_NOW, 12)} /> };
export const Dark: StoryObj = { ...GettingCheaper, parameters: { theme: "dark" } };
