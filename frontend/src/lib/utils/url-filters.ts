/**
 * List filters mirrored to the query string (DESIGN.md NAV-4): a filtered
 * view survives reload, back/forward and opening a detail, and can be shared.
 * Each filter is a string whose default is left out of the URL. Parameters the
 * list does not own (selection, dialogs, tabs) are kept untouched.
 * Never put credentials or message bodies here.
 */
export type FilterValues = Record<string, string>;

/** The filters named in `defaults`, read from `params`; absent keys take their default. */
export function readFilters<T extends FilterValues>(params: URLSearchParams, defaults: T): T {
  const values = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T & string>) {
    const value = params.get(key);
    if (value !== null) values[key] = value as T[typeof key];
  }
  return values;
}

/** A copy of `url` carrying `values`; a key at its default is removed. Other parameters stay. */
export function writeFilters(url: URL, values: FilterValues, defaults: FilterValues): URL {
  const next = new URL(url);
  for (const key of Object.keys(defaults)) {
    const value = values[key] ?? defaults[key];
    if (value === defaults[key]) next.searchParams.delete(key);
    else next.searchParams.set(key, value);
  }
  return next;
}

/** True when any filter differs from its default. Search text counts once trimmed. */
export function filtersActive(values: FilterValues, defaults: FilterValues): boolean {
  return Object.keys(defaults).some((key) => (values[key] ?? defaults[key]).trim() !== defaults[key].trim());
}

/** Stable comparison key for a set of filter values. */
export function filtersKey(values: FilterValues, defaults: FilterValues): string {
  return JSON.stringify(Object.keys(defaults).map((key) => values[key] ?? defaults[key]));
}
