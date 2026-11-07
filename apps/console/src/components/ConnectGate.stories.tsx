import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConnectGate } from "./ConnectGate.tsx";
const meta: Meta = { title: "Components/ConnectGate" };
export default meta;
export const Default: StoryObj = { render: () => <ConnectGate signIn onConnect={() => undefined} /> };
export const SelfHosted: StoryObj = { render: () => <ConnectGate onConnect={() => undefined} /> };
