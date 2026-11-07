import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx", "./*.stories.tsx"],
  // The app is served under /app/, so persona media is requested at /app/personas/<id>.webp. Same here.
  staticDirs: [{ from: "../public", to: "/app" }],
  framework: { name: "@storybook/react-vite", options: {} },
  core: { disableTelemetry: true },
  viteFinal: (config) => ({ ...config, base: "./" }),
};
export default config;
