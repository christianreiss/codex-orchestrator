import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { resolve } from "node:path";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import portalTailwind from "./tailwind.portal.config";

export default defineConfig({
  root: resolve(import.meta.dirname, "portal"),
  base: "/go/",
  plugins: [svelte()],
  // Lets portal code import the shared tokens, the reused ui/* components and
  // the tested pure helpers under src/lib/portal without a SvelteKit runtime.
  // Verified: nothing under src/lib/components/ui imports $app/*.
  resolve: {
    alias: { $lib: resolve(import.meta.dirname, "src/lib") },
  },
  // An inline postcss config disables config-file discovery, so the portal gets
  // its own Tailwind entrypoint while the admin build keeps postcss.config.js.
  css: {
    postcss: { plugins: [tailwindcss(portalTailwind), autoprefixer()] },
  },
  build: {
    outDir: resolve(import.meta.dirname, "../public/go"),
    emptyOutDir: true,
    // The bundle is committed and served publicly; a sourcemap here published
    // the full portal source to anyone who opened /go.
    sourcemap: false,
  },
  server: {
    port: 5174,
    // The fonts live in ../static, outside `root`.
    fs: { allow: [resolve(import.meta.dirname, ".")] },
    // Without disabling the timeouts the dev proxy cuts the SSE stream.
    proxy: {
      "/go/api": { target: "http://127.0.0.1:8488", timeout: 0, proxyTimeout: 0 },
    },
  },
});
