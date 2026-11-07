import type { Meta, StoryObj } from "@storybook/react-vite";
import { DiffView } from "./DiffView.tsx";
import { AUTONOMY_MD } from "../fake/fixtures.ts";

const meta = { title: "Workspace/DiffView", component: DiffView } satisfies Meta<typeof DiffView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Changed: Story = {
  args: {
    before: AUTONOMY_MD,
    after: AUTONOMY_MD.replace("risk: medium", "risk: high").replace("watch: 1h", "watch: 3h"),
  },
};
export const AddedArea: Story = {
  args: {
    before: AUTONOMY_MD,
    after: `${AUTONOMY_MD}\n## area: billing\npaths: src/billing/**\nrisk: high\n`,
  },
};
export const NoChanges: Story = { args: { before: AUTONOMY_MD, after: AUTONOMY_MD } };
/** Text from a proposal is never rendered as markup. */
export const HostileText: Story = {
  args: { before: "a", after: "a\n<img src=x onerror=alert(1)>\n<script>alert(1)</script>" },
};
export const Dark: Story = {
  args: { before: "one\ntwo\nthree", after: "one\n2\nthree\nfour" },
  parameters: { theme: "dark" },
};
