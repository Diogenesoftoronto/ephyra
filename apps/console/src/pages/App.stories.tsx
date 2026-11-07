import type { Meta, StoryObj } from "@storybook/react-vite";
import { App } from "./App.tsx";
const meta = { component: App } satisfies Meta<typeof App>;
export default meta;
const fake: typeof fetch = async () => new Response(null, { status: 503 });
export const Unavailable: StoryObj<typeof meta> = { args: { fetcher: fake } };
