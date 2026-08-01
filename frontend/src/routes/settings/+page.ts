import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { settingsLegacyTarget } from "$lib/legacy-admin-routes";

export const load = ({ url }: { url: URL }) => {
  const target = settingsLegacyTarget(url.searchParams, url.hash);
  throw redirect(308, `${base}${target}`);
};
