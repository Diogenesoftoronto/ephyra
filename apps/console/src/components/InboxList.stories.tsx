import type { Meta, StoryObj } from "@storybook/react-vite";
import { InboxList } from "./InboxList.tsx";
import { inbox } from "../storybook/data.ts";
const meta: Meta = { title: "Components/InboxList" };
export default meta;
export const Default: StoryObj = { render: () => <InboxList items={inbox} selected={inbox[0]!.trailId} /> };
export const Empty: StoryObj = { render: () => <InboxList items={[]} /> };
