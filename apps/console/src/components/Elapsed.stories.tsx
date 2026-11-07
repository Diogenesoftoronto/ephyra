import type { Meta, StoryObj } from "@storybook/react-vite";
import { Elapsed } from "./Elapsed.tsx";
import { NOW } from "../storybook/data.ts";

const meta = { title: "Activity/Elapsed", component: Elapsed } satisfies Meta<typeof Elapsed>;
export default meta;
type Story = StoryObj<typeof meta>;

const ago = (ms: number) => new Date(NOW - ms).toISOString();
/** The story clock is frozen, so this always reads 7m 12s. */
export const Running: Story = { args: { since: ago(7 * 60_000 + 12_000) } };
export const Hours: Story = { args: { since: ago(3 * 3_600_000 + 14 * 60_000) } };
export const Finished: Story = { args: { since: ago(10 * 60_000), until: ago(4 * 60_000) } };
/** With the real clock the counter ticks once a second. */
export const Ticking: Story = { args: { since: ago(30_000) }, parameters: { clock: null } };
