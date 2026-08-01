import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { legacyAuthoringTarget } from "$lib/legacy-admin-routes";

/** Legacy Authoring URLs remain bookmark-safe while canonical knowledge routes stay direct. */
export const load = ({ url }: { url: URL }) => {
  const path = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
  const suffix = path.slice("/authoring".length);
  const target = legacyAuthoringTarget(suffix);
  throw redirect(308, `${base}${target}${url.search}`);
};
