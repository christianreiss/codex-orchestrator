import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { PageLoad } from "./$types";

/**
 * `/admin` is the URL an operator actually types, so this is the real front
 * door; it forwards to the Overview before anything renders.
 *
 * The redirect runs in `load`, ahead of the layout's own auth gate, so the two
 * no longer race: on an unclaimed installation the gate (which only acts once
 * the auth store settles, and sees an unenforced console) sends the operator
 * on to `/setup` from `/dashboard`, and a signed-out one to `/login`.
 */
export const load: PageLoad = () => {
  redirect(307, `${base}/dashboard`);
};
