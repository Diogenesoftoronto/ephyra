import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunPage } from "./RunPage.tsx";
import { RUN_IDS } from "../fake/runs.ts";
const meta: Meta = { title: "Screens/RunPage" };
export default meta;
export const Live: StoryObj = { render: () => <RunPage runId={RUN_IDS.orb} retryMs={10} /> };
export const Finished: StoryObj = { render: () => <RunPage runId={RUN_IDS.local} /> };
export const Failed: StoryObj = { render: () => <RunPage runId={RUN_IDS.failed} /> };
export const Unavailable: StoryObj = { render: () => <RunPage runId={RUN_IDS.unavailable} /> };
