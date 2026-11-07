import type { Meta, StoryObj } from "@storybook/react-vite";
import { DraftEditor } from "./DraftEditor.tsx";
import { docs } from "../storybook/data.ts";
import { useState } from "react";
const meta: Meta = { title: "Components/DraftEditor" };
export default meta;
export const Default: StoryObj = {
  render: () => (
    <DraftEditor path="autonomy.md" content={docs[0]!.content} warnings={[]} onSave={async () => undefined} />
  ),
};
export const Editing: StoryObj = {
  render: function Editing() {
    const [content, setContent] = useState(docs[0]!.content);
    return (
      <DraftEditor
        path="autonomy.md"
        content={content}
        warnings={[]}
        onSave={async (text) => setContent(text)}
      />
    );
  },
};
export const Errors: StoryObj = {
  render: () => (
    <DraftEditor
      path="autonomy.md"
      content="## defaults\nmode: invalid"
      warnings={["error: invalid mode"]}
      onSave={async () => undefined}
    />
  ),
};
