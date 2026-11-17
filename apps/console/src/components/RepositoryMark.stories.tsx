import type { Meta, StoryObj } from "@storybook/react-vite";
import { RepositoryMark } from "./RepositoryMark.tsx";

const meta = { title: "Account/Repository mark", component: RepositoryMark } satisfies Meta<typeof RepositoryMark>;
export default meta;

export const Logo: StoryObj<typeof meta> = { args: { name: "Ephyra", sources: ["/app/brand/logo.svg"] } };
export const Initial: StoryObj<typeof meta> = { args: { name: "Observatory" } };
