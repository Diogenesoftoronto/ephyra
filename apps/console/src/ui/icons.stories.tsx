import type { Meta, StoryObj } from "@storybook/react-vite";
import { Icon, type IconName } from "./icons.tsx";

const names: IconName[] = [
  "overview",
  "usage",
  "inbox",
  "runs",
  "workspace",
  "personas",
  "copy",
  "check",
  "sun",
  "moon",
  "specimen",
];
const meta: Meta = { title: "UI/Icons" };
export default meta;
export const All: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 96px)", gap: 16 }}>
      {names.map((n) => (
        <div key={n} style={{ display: "grid", justifyItems: "center", gap: 8 }}>
          <Icon name={n} width={28} height={28} />
          <span className="ui-tag">{n}</span>
        </div>
      ))}
    </div>
  ),
};
