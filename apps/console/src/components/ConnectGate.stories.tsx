import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConnectGate } from "./ConnectGate.tsx";
import { useState } from "react";
const meta: Meta = { title: "Components/ConnectGate" };
export default meta;
export const Default: StoryObj = { render: () => <ConnectGate onConnect={() => undefined} /> };
