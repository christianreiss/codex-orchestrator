import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { PageLoad } from "./$types";

/** A project opens on its board; the old Identity page is now "About" in the header. */
export const load: PageLoad = ({ params }) => {
  redirect(307, `${base}/projects/${encodeURIComponent(params.slug)}/board`);
};
