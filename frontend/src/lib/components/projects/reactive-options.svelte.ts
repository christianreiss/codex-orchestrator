/**
 * Bridges Svelte 5 reactive getters into the writable store API that
 * `@tanstack/svelte-query`'s `createQuery` / `createMutation` consume.
 *
 *   const opts = reactiveOptions(() => ({
 *     queryKey: projectKeys.detail(slug),
 *     queryFn: () => fetchProject(slug),
 *   }));
 *   const query = createQuery(opts);
 *
 * Must be called inside a component or `$effect.root`.
 */
import { writable, type Readable } from "svelte/store";

export function reactiveOptions<T>(getter: () => T): Readable<T> {
  const store = writable<T>(getter());
  $effect(() => {
    store.set(getter());
  });
  return { subscribe: store.subscribe };
}
