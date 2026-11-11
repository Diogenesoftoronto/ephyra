import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { FakeApi } from "../fake/api.ts";
import type { ConversationMode } from "../fake/assist.ts";
import { ActivityFeed } from "../components/ActivityFeed.tsx";
import { CompanionPanel, VelumInvoker } from "./CompanionPanel.tsx";
import { Referable, VelumProvider, useVelum } from "./VelumProvider.tsx";

const meta: Meta = {
  title: "Velum/Companion",
  parameters: {
    docs: {
      description: {
        component:
          "One workspace conversation for typed and spoken turns. Fixture replies only; no model is contacted.",
      },
    },
  },
};
export default meta;
const TRAIL = "3a77e1aa-5b1e-4c3a-9d2f-000000000003";
function Open({ select, refer }: { select?: boolean; refer?: boolean }) {
  const env = useVelum();
  useEffect(() => {
    env?.setOpen(true, false);
    if (refer) env?.companion.add({ kind: "trail", id: TRAIL, rev: 3 }, "T-3a77e1 revision 3", "trail:story", "#/inbox/x");
    if (select) env?.setSelecting(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
const frame = (conversation: ConversationMode, opts: { select?: boolean; refer?: boolean; canSpend?: boolean } = {}) => (
  <VelumProvider api={new FakeApi({ conversation })} scope={`story-${conversation}`} context={{ kind: "overview" }} contextLabel="Application overview"
    canSpend={opts.canSpend ?? true}>
    <div style={{ display: "grid", gap: 24, maxWidth: 520 }}>
      <VelumInvoker />
      <Referable id="trail:story" refData={{ kind: "trail", id: TRAIL, rev: 3 }} label="T-3a77e1 revision 3">
        <div className="ui-card"><strong>Webhook retries charge a customer twice</strong><p>T-3a77e1 · revision 3</p></div>
      </Referable>
      <ActivityFeed items={[]} />
    </div>
    <CompanionPanel />
    <Open {...opts} />
  </VelumProvider>
);
export const Empty: StoryObj = { render: () => frame("fixture") };
export const WithReference: StoryObj = { render: () => frame("fixture", { refer: true }) };
export const ChoosingContext: StoryObj = { render: () => frame("fixture", { select: true }) };
export const UnconfirmedReply: StoryObj = { render: () => frame("uncertain", { refer: true }) };
export const RateLimited: StoryObj = { render: () => frame("rate-limited") };
export const ReferenceChanged: StoryObj = { render: () => frame("stale-reference", { refer: true }) };
export const VelumUnavailable: StoryObj = { render: () => frame("unavailable") };
export const ReadOnlyViewer: StoryObj = { render: () => frame("fixture", { canSpend: false }) };
