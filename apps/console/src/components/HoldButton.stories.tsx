import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HoldButton } from "./HoldButton.tsx";

/** On a touchscreen, press and hold to confirm. A mouse click or Enter confirms at once. Nothing is sent anywhere. */
const meta: Meta = { title: "Interaction/Hold button" };
export default meta;

function Demo({ variant = "primary" as const }: { variant?: "primary" | "danger" }) {
  const [count, setCount] = useState(0);
  return <div style={{ display: "grid", gap: 12, justifyItems: "start" }}>
    <HoldButton variant={variant} holdLabel="Hold to approve" onConfirm={() => setCount((n) => n + 1)}>Approve</HoldButton>
    <p className="muted" role="status">Confirmed {count} {count === 1 ? "time" : "times"} (fixture).</p>
  </div>;
}
export const Default: StoryObj = { render: () => <Demo /> };
export const Danger: StoryObj = { render: () => <Demo variant="danger" /> };
export const Loading: StoryObj = { render: () => <HoldButton loading onConfirm={() => undefined}>Approve</HoldButton> };
