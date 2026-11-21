import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { legacyTarget } from "$lib/legacy-admin-routes";
import type { PageLoad } from "./$types";

// The detail route also matches the old registration bookmark.
export const load: PageLoad = ({ params, url }) => {
  const target = legacyTarget(`/hosts/${params.id}`, url.searchParams);
  if (target) redirect(308, `${base}${target}`);
};
