import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThemeToggle } from "./ThemeToggle.tsx";

const meta: Meta = { title: "Components/ThemeToggle" };
export default meta;
export const Default: StoryObj = { render: () => <ThemeToggle /> };
export const DarkSelected: StoryObj = {
  ...Default,
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[data-choice="dark"]')?.click();
  },
};
export const LightSelected: StoryObj = {
  ...Default,
  parameters: { theme: "light" },
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[data-choice="light"]')?.click();
  },
};
export const KeyboardFocus: StoryObj = {
  ...Default,
  play: async ({ canvasElement }) => canvasElement.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus(),
};
export const Phone: StoryObj = { ...Default, globals: { viewport: { value: "phone" } } };
