import type { Meta, StoryObj } from "@storybook/react-vite";
import { DecisionForm } from "./DecisionForm.tsx";
import { useState } from "react";
const meta: Meta = { title: "Components/DecisionForm" };
export default meta;
export const Default: StoryObj = { render: () => <DecisionForm busy={null} onSubmit={() => undefined} /> };
export const Busy: StoryObj = { render: () => <DecisionForm busy="approve" onSubmit={() => undefined} /> };
