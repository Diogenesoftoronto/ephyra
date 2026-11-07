import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProposalCard } from "./ProposalCard.tsx";
import { draft } from "../storybook/data.ts";
import { useState } from "react";
const meta: Meta = { title: "Components/ProposalCard" };
export default meta;
export const Default: StoryObj = {
  render: () => (
    <ProposalCard
      proposal={{ summary: "Add intent", content: `${draft.content}\nA coupon applies once.`, warnings: [] }}
      currentContent={draft.content}
      onApply={async () => undefined}
    />
  ),
};
export const ParserError: StoryObj = {
  render: () => (
    <ProposalCard
      proposal={{ summary: "Invalid draft", content: "mode: invalid", warnings: ["error: invalid mode"] }}
      currentContent={draft.content}
      onApply={async () => undefined}
    />
  ),
};
