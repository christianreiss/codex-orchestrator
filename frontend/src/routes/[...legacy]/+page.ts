import { error, redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { legacyTarget } from "$lib/legacy-admin-routes";
import type { PageLoad } from "./$types";

/** Retired URLs redirect here; anything else is a real 404. */
export const load: PageLoad = ({ url }) => {
  const path = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
  const target = legacyTarget(path, url.searchParams, url.hash);
  if (target) redirect(308, `${base}${target}`);
  error(404, "Page not found");
};
