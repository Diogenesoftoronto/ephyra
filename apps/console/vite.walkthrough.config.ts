import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: "/e/app/", plugins: [react()],
  build: { outDir: "dist-walkthrough", rollupOptions: { input: "walkthrough.html" } },
});
