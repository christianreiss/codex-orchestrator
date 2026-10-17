import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";

// Quick Settings became the "Model defaults" tab of Engines.
export const load = () => {
  throw redirect(308, `${base}/engines#defaults`);
};
