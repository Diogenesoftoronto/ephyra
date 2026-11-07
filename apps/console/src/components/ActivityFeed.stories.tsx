import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityFeed, ActivityRow } from "./ActivityFeed.tsx";
import { activity } from "../storybook/data.ts";

const meta = { title: "Activity/ActivityFeed", component: ActivityFeed } satisfies Meta<typeof ActivityFeed>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mixed: Story = { args: { items: activity } };
export const RunningOnly: Story = { args: { items: activity.filter((a) => a.status === "running") } };
export const Empty: Story = { args: { items: [] } };
export const Row: Story = { args: { items: [] }, render: () => <ul><ActivityRow item={activity[0]!} /></ul> };
export const Dark: Story = { args: { items: activity }, parameters: { theme: "dark" } };
export const Mobile: Story = { args: { items: activity }, globals: { viewport: { value: "phone" } } };
