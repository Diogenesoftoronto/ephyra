import type { Decorator, Preview } from "@storybook/react-vite";
import { useEffect, useMemo } from "react";
import { ApiProvider } from "../src/app/ApiContext.tsx";
import { FakeApi, type FakeOptions } from "../src/fake/api.ts";
import { STORY_NOW } from "../src/fake/fixtures.ts";
import { ClockProvider } from "../src/lib/clock.tsx";
import "../src/theme.css";
import "../src/ui/ui.css";
import "../src/layout.css";

declare module "@storybook/react-vite" {
  interface Parameters {
    /** Options for the FakeApi each story gets (stale approvals, unavailable Velum, empty data…). */
    fake?: FakeOptions;
    /** Force a theme for this story regardless of the toolbar. */
    theme?: "light" | "dark";
    /** Freeze the clock (default) or let it run (`null`). */
    clock?: number | null;
  }
}

const withEnvironment: Decorator = (Story, context) => {
  const theme =
    context.parameters.theme ?? (context.globals.theme as "light" | "dark" | undefined) ?? "light";
  const api = useMemo(() => new FakeApi(context.parameters.fake), [context.id, context.parameters.fake]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.body.style.background = "var(--bg)";
  }, [theme]);
  const clock = context.parameters.clock === undefined ? STORY_NOW : context.parameters.clock;
  return (
    <ApiProvider api={api}>
      <ClockProvider now={clock}>
        <div className="sb-frame">
          <Story />
        </div>
      </ClockProvider>
    </ApiProvider>
  );
};

const preview: Preview = {
  decorators: [withEnvironment],
  globalTypes: {
    theme: {
      description: "Theme",
      toolbar: { title: "Theme", icon: "circlehollow", items: ["light", "dark"], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: "light" },
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    actions: { disable: true },
    viewport: {
      options: { phone: { name: "Phone 375", styles: { width: "375px", height: "720px" }, type: "mobile" } },
    },
  },
};
export default preview;
