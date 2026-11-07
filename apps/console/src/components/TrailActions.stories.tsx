import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Trail } from "@ephyra/core";
import { TrailActions } from "./TrailActions.tsx";

const meta: Meta = { title: "Components/TrailActions" };
export default meta;
const principal = "did:example:reviewer-a";
function Example({ owner: initialOwner, parked: initialParked = false, ...props }: Partial<ComponentProps<typeof TrailActions>>) {
  const [owner, setOwner] = useState<Trail["owner"]>(initialOwner);
  const [parked, setParked] = useState(initialParked);
  return <TrailActions
    principal={principal}
    owner={owner}
    parked={parked}
    canClaim={!parked}
    onAct={async (action) => {
      if (action === "claim") setOwner({ kind: "human", id: principal });
      if (action === "release") setOwner(undefined);
      if (action === "park") setParked(true);
      if (action === "resume") setParked(false);
    }}
    {...props}
  />;
}
export const Default: StoryObj = { render: () => <Example /> };
export const Mine: StoryObj = { render: () => <Example owner={{ kind: "human", id: principal }} /> };
export const AnotherReviewer: StoryObj = {
  render: () => <Example owner={{ kind: "human", id: "did:example:reviewer-b" }} />,
};
export const ReadOnly: StoryObj = { render: () => <Example canAct={false} /> };
export const UnavailableDuringAgentWork: StoryObj = { render: () => <Example canClaim={false} /> };
export const Parked: StoryObj = { render: () => <Example parked canClaim={false} /> };
export const UnconfirmedChange: StoryObj = { render: () => <Example blocked /> };
export const LegacyOwnerUnavailable: StoryObj = { render: () => <Example ownerUnknown canClaim={false} /> };
