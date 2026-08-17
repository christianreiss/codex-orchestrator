import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import pkg from "./package.json" with { type: "json" };

// SvelteKit defaults kit.version.name to Date.now(), which feeds a hash into
// every entry/chunk filename. That makes the build non-reproducible even with
// zero source changes, which CI's "committed admin artifact matches a fresh
// build" check depends on being false. The git commit SHA isn't a valid pin
// either: the artifact for commit X is built while X is still uncommitted
// (HEAD is X's parent), so a rebuild after checking out the finished commit
// X would hash a different SHA and fail the same check. Pin to package.json's
// version instead — it's already in the tree at build time, so a rebuild of
// the same source is always byte-identical.
const versionName = pkg.version;

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
