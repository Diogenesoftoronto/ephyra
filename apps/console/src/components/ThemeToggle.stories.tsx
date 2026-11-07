import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThemeToggle } from "./ThemeToggle.tsx";

const meta: Meta = { title: "Components/ThemeToggle" };
export default meta;
export const Default: StoryObj = { render: () => <ThemeToggle /> };
