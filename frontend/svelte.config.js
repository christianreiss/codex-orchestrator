import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { buildVersion } from "./scripts/build-version.mjs";

// SvelteKit checks this on a failed lazy import. An older tab must recognize
// a new release, including a build made before its delivery commit exists.
const versionName = buildVersion(fileURLToPath(new URL(".", import.meta.url)));

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: "build",
      assets: "build",
      fallback: "index.html",
      precompress: false,
      strict: false,
    }),
    version: {
      name: versionName,
    },
    paths: {
      base: "/admin",
    },
    alias: {
      $lib: "src/lib",
      "$lib/*": "src/lib/*",
    },
    appDir: "_app",
    typescript: {
      config: (config) => {
        config.include = [...(config.include ?? []), "../vite.config.ts"];
        return config;
      },
    },
  },
};

export default config;
