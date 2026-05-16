import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

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
        config.include = [
          ...(config.include ?? []),
          "../vite.config.ts",
        ];
        return config;
      },
    },
  },
};

export default config;
