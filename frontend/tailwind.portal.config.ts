import type { Config } from "tailwindcss";
import base from "./tailwind.config";

/**
 * The portal's Tailwind entrypoint.
 *
 * It is separate from the admin config for two reasons. Adding `./portal/**` to
 * the admin `content` glob would emit portal-only utilities into the admin
 * bundle; and the admin runs `darkMode: ["class"]`, which the portal cannot use
 * because its CSP blocks the inline script that sets the class before paint.
 * The portal follows the system preference instead, matching the
 * `:root[data-auto-scheme]` media block in lib/styles/tokens.css.
 *
 * Everything else -- the semantic colour families, radius scale, shadows,
 * easing and type scale -- comes across from the admin config by spread, so the
 * two surfaces stay one visual system.
 */
const config = {
  ...base,
  darkMode: "media",
  content: [
    "./portal/index.html",
    "./portal/src/**/*.{html,js,svelte,ts}",
    // The handful of admin components the portal reuses; scoped so unused
    // component utilities do not land in the portal bundle.
    "./src/lib/components/ui/{button,badge,textarea,separator,skeleton}/**/*.{svelte,ts}",
    "./src/lib/portal/**/*.ts",
  ],
  theme: {
    ...base.theme,
    extend: {
      ...base.theme!.extend,
      fontFamily: {
        ...base.theme!.extend!.fontFamily,
        // The portal bundles Inter only. Naming JetBrains Mono here would point
        // `font-mono` at a face that never loads under /go.
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
} satisfies Config;

export default config;
