import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TrailEvent } from "@ephyra/core";
import { TrailDiscussion } from "./TrailDiscussion.tsx";
import { eventsFor } from "../storybook/data.ts";
import { ApiError, UnknownWriteOutcome } from "../api.ts";

const meta: Meta = { title: "Components/TrailDiscussion" };
export default meta;
const principal = "did:example:reviewer-a";
const base = eventsFor("c2d018")[0]!;
const comment = (n: number, text: string, actor = principal): TrailEvent => ({
  ...base, id: `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  at: `2026-11-07T10:${String(20 + n).padStart(2, "0")}:00.000Z`,
  actor: { kind: "human", id: actor }, type: "human_comment", data: { text, isRequest: false },
});
const recorded: TrailEvent[] = [
  comment(1, "Keep the receipt rounding as is; finance reads those.", "did:example:reviewer-b"),
  { ...comment(2, ""), type: "claimed_by_human", data: {} },
  comment(3, "I’m checking the coupon path against the reproduction."),
];
type Props = ComponentProps<typeof TrailDiscussion>;
function Example({ initialDraft = "", events: initialEvents = recorded, ...props }: Partial<Props> & { initialDraft?: string }) {
  const [draft, setDraft] = useState(initialDraft);
  const [events, setEvents] = useState(initialEvents);
  return <TrailDiscussion
    principal={principal}
    events={events}
    draft={draft}
    onDraftChange={setDraft}
    onComment={async (text) => { setEvents((all) => [...all, comment(all.length + 1, text)]); setDraft(""); }}
    {...props}
  />;
}
export const Default: StoryObj = { render: () => <Example /> };
export const Empty: StoryObj = { render: () => <Example events={[]} /> };
export const ReadOnly: StoryObj = { render: () => <Example canComment={false} /> };
export const Connecting: StoryObj = { render: () => <Example status="connecting" events={[]} /> };
export const Disconnected: StoryObj = {
  render: () => <Example status="disconnected" initialDraft="This draft stays while updates are paused." />,
};
export const Reconnecting: StoryObj = {
  render: () => <Example status="reconnecting" initialDraft="Please check the receipt boundary too." />,
};
export const Unavailable: StoryObj = {
  render: () => <Example status="error" initialDraft="Keep this note." error={new ApiError(503, "Updates are unavailable.")} />,
};
export const Sending: StoryObj = { render: () => <Example busy initialDraft="Checking the edge case." /> };
export const Unconfirmed: StoryObj = {
  render: () => <Example
    unconfirmed
    initialDraft="Check the coupon path too."
    error={new UnknownWriteOutcome("story-comment-operation")}
    onReconcile={async () => undefined}
  />,
};
export const LongContent: StoryObj = {
  render: () => <Example events={[
    comment(1, "Keep the receipt rounding unchanged.\n\n" + "This is additional review context. ".repeat(35)),
    comment(2, "A long identifier must wrap: " + "checkoutCouponPath".repeat(15), "did:example:" + "long-reviewer-identifier-".repeat(8)),
    comment(3, '<script>alert("untrusted comment")</script> is shown as plain text.'),
  ]} />,
};
