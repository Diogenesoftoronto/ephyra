import type { Preview } from "@storybook/react-vite";
import "../src/theme.css";
import "../src/ui/ui.css";

const preview: Preview = {
  globalTypes: {
    theme: { description: "Theme", toolbar: { title: "Theme", icon: "mirror", items: ["light", "dark"], dynamicTitle: true } },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    (Story, ctx) => {
      document.documentElement.dataset.theme = ctx.globals.theme;
      return <Story />;
    },
  ],
  parameters: { layout: "padded", backgrounds: { disable: true } },
};
export default preview;
