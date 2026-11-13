import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SwipeRow } from "./SwipeRow.tsx";

/** Drag a row sideways with a finger or pen. With a mouse, use the links in the row instead. Nothing is sent anywhere. */
const meta: Meta = { title: "Interaction/Swipe row" };
export default meta;

function Demo() {
  const [log, setLog] = useState<string[]>([]);
  const rows = ["Checkout returns 500 when a coupon is applied twice", "Session cookie is lost on the Safari redirect"];
  return <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
    {rows.map((title) => <SwipeRow key={title}
      right={{ label: "Review", icon: "→", tone: "go", onCommit: () => setLog((l) => [`Opened: ${title}`, ...l]) }}
      left={{ label: "Why a person?", icon: "?", tone: "calm", onCommit: () => setLog((l) => [`Explained: ${title}`, ...l]) }}>
      <div style={{ padding: "12px 16px", border: "1px solid var(--line)", borderRadius: 8 }}><strong>{title}</strong></div>
    </SwipeRow>)}
    <ul className="muted" role="status">{log.slice(0, 4).map((l, i) => <li key={i}>{l}</li>)}</ul>
  </div>;
}
export const Default: StoryObj = { render: () => <Demo /> };
export const Narrow: StoryObj = { render: () => <Demo />, globals: { viewport: { value: "phone" } } };
