import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { PageLoad } from "./$types";

/**
 * Todos are the project board now. Migration 0026 moved every one onto a card
 * and kept its id as the card number, so this page had become a narrower view
 * of the same rows — showing only "done or not" where the board shows which
 * lane the work is in and who is holding it.
 *
 * The route is kept as a redirect rather than deleted: it is in the browser
 * history and the muscle memory of anyone who has used this console, and a 404
 * would read as the work having disappeared. The `project_todo_*` API is
 * untouched and still serves the same ids.
 */
export const load: PageLoad = ({ params }) => {
  redirect(307, `${base}/projects/${encodeURIComponent(params.slug)}/board`);
};
