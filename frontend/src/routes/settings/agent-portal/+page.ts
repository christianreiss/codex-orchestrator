import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
export const load = () => { throw redirect(308, `${base}/agent-portal`); };
