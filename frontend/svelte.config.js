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
          // The portal is a separate Vite app rather than a SvelteKit route,
          // so svelte-check would not see it otherwise.
          "../vite.portal.config.ts",
          "../tailwind.portal.config.ts",
          "../portal/src/**/*.ts",
          "../portal/src/**/*.svelte",
        ];
        return config;
      },
    },
  },
};

export default config;
