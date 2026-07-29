import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "portal"),
  base: "/go/",
  plugins: [svelte()],
  build: {
    outDir: resolve(import.meta.dirname, "../public/go"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5174,
    proxy: { "/go/api": "http://127.0.0.1:8488" },
  },
});
