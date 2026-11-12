import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { offlineApp } from "./build/offline-app.mjs";

const BASE = "/libris-focus-tracker/";

export default defineConfig({
  base: BASE,
  plugins: [react(), offlineApp(BASE) as Plugin],
  build: { sourcemap: true },
});
