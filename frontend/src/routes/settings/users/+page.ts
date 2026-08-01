import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
export const load = ({ url }: { url: URL }) => {
  const query = url.search ? url.search : "";
  throw redirect(308, `${base}/users${query}`);
};
