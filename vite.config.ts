import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const BASE = "/libris-focus-tracker/";

function offlineApp(): Plugin {
  let root = "";
  return {
    name: "libris-offline-app",
    apply: "build",
    configResolved(config) { root = config.root; },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const publicDir = resolve(root, "public");
        const template = readFileSync(resolve(publicDir, "sw.js"), "utf8");
        const files = Object.keys(bundle).filter((name) => !name.endsWith(".map"));
        const publicFiles = readdirSync(publicDir, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name !== "sw.js")
          .map((entry) => resolve(entry.parentPath, entry.name).slice(publicDir.length + 1).split("\\").join("/"));
        const revision = createHash("sha256").update(template);
        for (const name of [...files].sort()) {
          const entry = bundle[name];
          revision.update(name).update(entry.type === "chunk" ? entry.code : entry.source);
        }
        for (const name of [...publicFiles].sort()) revision.update(name).update(readFileSync(resolve(publicDir, name)));
        const precache = Array.from(new Set([BASE, ...files.concat(publicFiles).map((name) => `${BASE}${name}`)])).sort();
        const html = bundle["index.html"];
        if (!html || html.type !== "asset") throw new Error("Missing HTML app shell for offline build.");
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: template
            .replace('"__LIBRIS_BASE__"', JSON.stringify(BASE))
            .replace('"__LIBRIS_REVISION__"', JSON.stringify(revision.digest("hex").slice(0, 16)))
            .replace('"__LIBRIS_SHELL__"', JSON.stringify(String(html.source)))
            .replace('["__LIBRIS_PRECACHE__"]', JSON.stringify(precache)),
        });
      },
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [react(), offlineApp()],
  build: { sourcemap: true },
});
