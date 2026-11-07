import type { Meta, StoryObj } from "@storybook/react-vite";
import { DocList } from "./DocList.tsx";
import { docs } from "../storybook/data.ts";
const meta: Meta = { title: "Components/DocList" };
export default meta;
export const Default: StoryObj = { render: () => <DocList docs={docs} onDraft={() => undefined} /> };
export const Empty: StoryObj = { render: () => <DocList docs={[]} onDraft={() => undefined} /> };
