type Settings = Record<string, unknown>;
function object(value: unknown): value is Settings {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function sameSettings(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
export function parseNativeSettings(text: string): Settings {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new Error(`Enter valid JSON: ${error instanceof Error ? error.message : "invalid syntax"}`);
  }
  if (!object(parsed)) throw new Error("Native settings must be a JSON object, for example {}.");
  return parsed;
}
export function nativeSettingsOf(settings: Settings | null | undefined): Settings {
  return object(settings?.native_settings) ? settings.native_settings : {};
}
export function mergeNativeSettings(base: Settings, latest: Settings, draft: Settings): Settings {
  const previous = nativeSettingsOf(base), current = nativeSettingsOf(latest);
  if (!sameSettings(previous, current) && !sameSettings(draft, current)) {
    throw new Error("Native settings changed elsewhere. Your draft is kept; copy it before loading the saved settings.");
  }
  return { ...latest, native_settings: draft };
}
/** Apply only edited leaves; preserve both unrepresented fields and independent updates. */
export function mergeFormSettings(base: Settings, latest: Settings, initialForm: Settings, draft: Settings): Settings {
  function merge(before: unknown, current: unknown, initial: unknown, edited: unknown, path: string): unknown {
    if (sameSettings(initial, edited)) return current;
    if ((object(initial) || initial === undefined) && (object(edited) || edited === undefined) && (object(initial) || object(edited))) {
      const initialObject = object(initial) ? initial : {};
      const editedObject = object(edited) ? edited : {};
      const result = { ...(object(current) ? current : {}) };
      for (const key of new Set([...Object.keys(initialObject), ...Object.keys(editedObject)])) {
        const next = merge(object(before) ? before[key] : undefined, object(current) ? current[key] : undefined,
          initialObject[key], editedObject[key], path ? `${path}.${key}` : key);
        if (next === undefined) delete result[key];
        else Object.defineProperty(result, key, { value: next, enumerable: true, configurable: true, writable: true });
      }
      return Object.keys(result).length ? result : undefined;
    }
    if (!sameSettings(before, current) && !sameSettings(edited, current)) {
      throw new Error(`${path} changed elsewhere. Refresh and review the saved settings before saving.`);
    }
    return edited;
  }
  return (merge(base, latest, initialForm, draft, "") ?? {}) as Settings;
}
/** The command-only form must not flatten richer hooks or their options. */
export function hasAdvancedHooks(value: unknown): boolean {
  if (!object(value)) return false;
  return Object.values(value).some(entries => !Array.isArray(entries) || entries.some(entry => {
    if (!object(entry) || Object.keys(entry).some(key => !["matcher", "hooks", "commands"].includes(key))) return true;
    return Array.isArray(entry.hooks) && entry.hooks.some(hook => !object(hook) || hook.type !== "command"
      || Object.keys(hook).some(key => !["type", "command"].includes(key)));
  }));
}
