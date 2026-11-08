/**
 * Reactive list filters kept in the URL. Construct during component init.
 *
 *   const filterState = new UrlFilters({ q: "", status: "" });  // not `filters`: Toolbar has a snippet of that name
 *   <Toolbar bind:search={filterState.values.q} filtersActive={filterState.active} onClearFilters={() => filterState.clear()} />
 *
 * Typing updates `values` and the address bar at once; routing uses a short debounce
 * (replaceState, focus and scroll kept). Back/forward or a link that changes
 * the parameters flows back into `values`.
 */
import { untrack } from "svelte";
import { beforeNavigate, goto, replaceState } from "$app/navigation";
import { page } from "$app/state";
import { filtersActive, filtersKey, readFilters, writeFilters, type FilterValues } from "./url-filters";

export class UrlFilters<T extends FilterValues> {
  values: T = $state({} as T);
  readonly #defaults: T;
  /** The values last written to or adopted from the URL. */
  #synced: string;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #needsCommit = false;

  constructor(defaults: T, debounceMs = 200) {
    this.#defaults = defaults;
    this.values = readFilters(untrack(() => page.url.searchParams), defaults);
    this.#synced = filtersKey(this.values, defaults);

    beforeNavigate((navigation) => {
      if (navigation.type === "popstate" || navigation.willUnload || !navigation.to) return;
      const current = page.url;
      if (navigation.to.url.pathname === current.pathname) return;
      const next = writeFilters(current, this.values, defaults);
      if (next.search === current.search && !this.#needsCommit) return;
      // A shallow replaceState changes the address bar but keeps SvelteKit's
      // old restoration URL. Finish a real replace navigation before pushing
      // the detail page, so Back restores the latest filters too.
      navigation.cancel();
      clearTimeout(this.#timer);
      const destination = navigation.to.url;
      void goto(next, { replaceState: true, keepFocus: true, noScroll: true })
        .then(() => { this.#needsCommit = false; return goto(destination); });
    });

    $effect(() => {
      const snapshot = { ...this.values };
      const key = filtersKey(snapshot, defaults);
      untrack(() => {
        const current = page.url;
        const next = writeFilters(current, snapshot, defaults);
        if (next.search !== current.search) {
          // Reload and copying the address must see edits before the debounce.
          // This shallow update still needs a real router commit for Back.
          this.#needsCommit = true;
          this.#synced = key;
          replaceState(next, page.state);
        }
      });
      this.#timer = setTimeout(() => {
        const current = untrack(() => page.url);
        this.#synced = filtersKey(snapshot, defaults);
        const next = writeFilters(current, snapshot, defaults);
        if (next.search !== current.search || this.#needsCommit) {
          void goto(next, { replaceState: true, keepFocus: true, noScroll: true }).then(() => {
            if (filtersKey(this.values, defaults) === key) this.#needsCommit = false;
          });
        }
      }, debounceMs);
      return () => clearTimeout(this.#timer);
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
