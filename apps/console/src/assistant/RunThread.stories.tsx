import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunThread } from "./RunThread.tsx";
import { runs } from "../storybook/data.ts";
const meta: Meta = { title: "Components/RunThread" };
export default meta;
export const Recorded: StoryObj = { render: () => <RunThread run={runs[0]!.run} events={runs[0]!.events} /> };
export const Empty: StoryObj = { render: () => <RunThread run={runs[0]!.run} events={[]} /> };
