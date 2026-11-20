/**
 * The name a detail page gives the object it shows, for the last breadcrumb
 * (a host's FQDN instead of "Host #12"). The route registry only knows the
 * URL; the page knows the object once it has loaded.
 *
 * Keyed by pathname, so a label never outlives its page or shows on another
 * one. `TopBar.svelte` is the only reader.
 */
import { writable } from "svelte/store";

export interface PageLabel {
  /** `page.url.pathname` of the page that set it. */
  path: string;
  label: string;
}

export const pageLabel = writable<PageLabel | null>(null);

/** Call from a page `$effect` and return the result: it clears the label on teardown. */
export function setPageLabel(path: string, label: string): () => void {
  pageLabel.set({ path, label });
  return () => pageLabel.update((current) => (current?.path === path ? null : current));
}
