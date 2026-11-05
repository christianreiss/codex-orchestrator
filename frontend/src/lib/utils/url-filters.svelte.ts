/**
 * Reactive list filters kept in the URL. Construct during component init.
 *
 *   const filterState = new UrlFilters({ q: "", status: "" });  // not `filters`: Toolbar has a snippet of that name
 *   <Toolbar bind:search={filterState.values.q} filtersActive={filterState.active} onClearFilters={() => filterState.clear()} />
 *
 * Typing updates `values` at once and the address bar after a short debounce
 * (replaceState, focus and scroll kept). Back/forward or a link that changes
 * the parameters flows back into `values`.
 */
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { filtersActive, filtersKey, readFilters, writeFilters, type FilterValues } from "./url-filters";

export class UrlFilters<T extends FilterValues> {
  values: T = $state({} as T);
  readonly #defaults: T;
  /** The values last written to or adopted from the URL. */
  #synced: string;

  constructor(defaults: T, debounceMs = 200) {
    this.#defaults = defaults;
    this.values = readFilters(untrack(() => page.url.searchParams), defaults);
    this.#synced = filtersKey(this.values, defaults);

    $effect(() => {
      const snapshot = { ...this.values };
      const timer = setTimeout(() => {
        const current = untrack(() => page.url);
        this.#synced = filtersKey(snapshot, defaults);
        const next = writeFilters(current, snapshot, defaults);
        if (next.search !== current.search) void goto(next, { replaceState: true, keepFocus: true, noScroll: true });
      }, debounceMs);
      return () => clearTimeout(timer);
    });

    $effect(() => {
      const fromUrl = readFilters(page.url.searchParams, defaults);
      untrack(() => {
        const key = filtersKey(fromUrl, defaults);
        if (key === this.#synced) return;
        this.#synced = key;
        Object.assign(this.values, fromUrl);
      });
    });
  }

  get active(): boolean {
    return filtersActive(this.values, this.#defaults);
  }

  clear(): void {
    Object.assign(this.values, this.#defaults);
  }
}
