import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { settingsLegacyTarget } from "$lib/legacy-admin-routes";
import type { PageLoad } from "./$types";

/** `url.hash` is only readable in `load` in production builds; the dev server throws, so fall back to the address bar. */
function hashOf(url: URL): string {
  try {
    return url.hash;
  } catch {
    return typeof location === "undefined" ? "" : location.hash;
  }
}

/** Bookmarks from the retired Settings hub (`/settings?tab=…#section`) land on their new home. */
export const load: PageLoad = ({ url }) => {
  const target = settingsLegacyTarget(url.searchParams, hashOf(url));
  if (target) redirect(308, `${base}${target}`);
};
