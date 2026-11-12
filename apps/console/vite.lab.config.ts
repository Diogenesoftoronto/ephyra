import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// The design lab: simulated quests on the real loop kit. Built beside the console, never shipped inside it.
export default defineConfig({
  base: "/app/", plugins: [react()],
  build: { outDir: "dist-lab", rollupOptions: { input: "lab.html" } },
});
