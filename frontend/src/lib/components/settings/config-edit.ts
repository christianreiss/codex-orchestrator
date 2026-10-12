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

const profileKeys = ["model", "model_reasoning_effort", "native_settings"] as const;
const profileName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
type Profile = Settings & { name: string };
function profiles(settings: Settings): Profile[] {
  return Array.isArray(settings.profiles) ? settings.profiles.filter((p): p is Profile => object(p) && typeof p.name === "string") : [];
}
/** Expose authored profile fields without claiming ownership of legacy siblings. */
export function editableProfilesOf(settings: Settings | null | undefined): Profile[] {
  return profiles(settings ?? {}).map(p => Object.fromEntries([
    ["name", p.name], ...profileKeys.filter(k => p[k] !== undefined).map(k => [k, p[k]]),
  ]) as Profile);
}
export function parseNativeProfiles(text: string): Profile[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Enter valid JSON for the profile array."); }
  if (!Array.isArray(value)) throw new Error("Profiles must be a JSON array, for example [].");
  const names = new Set<string>();
  for (const p of value) {
    if (!object(p) || typeof p.name !== "string" || !profileName.test(p.name)) throw new Error("Each profile needs a name: 1–64 letters, digits, underscores or hyphens; start with a letter or digit.");
    if (names.has(p.name)) throw new Error(`Duplicate profile name: ${p.name}`);
    names.add(p.name);
    if (Object.keys(p).some(k => k !== "name" && !profileKeys.includes(k as typeof profileKeys[number]))) throw new Error(`Profile ${p.name}: use name, model, model_reasoning_effort and native_settings. Put other native fields inside native_settings.`);
    for (const key of ["model", "model_reasoning_effort"]) {
      if (p[key] !== undefined && p[key] !== null && typeof p[key] !== "string") throw new Error(`Profile ${p.name}: ${key} must be a string, or omitted/null to inherit.`);
    }
    if (p.native_settings !== undefined && !object(p.native_settings)) throw new Error(`Profile ${p.name}: native_settings must be a JSON object.`);
  }
  return value as Profile[];
}
export function mergeNativeProfiles(base: Settings, latest: Settings, draft: Profile[]): Settings {
  const before = new Map(profiles(base).map(p => [p.name, p]));
  const current = new Map(profiles(latest).map(p => [p.name, p]));
  const edited = new Map(draft.map(p => [p.name, p]));
  for (const [name, previous] of before) {
    if (!edited.has(name)) {
      if (current.has(name) && !sameSettings(previous, current.get(name))) throw new Error(`Profile ${name} changed elsewhere; reload before removing it.`);
      current.delete(name);
    }
  }
  for (const [name, p] of edited) {
    const previous = before.get(name);
    const initial = previous ? editableProfilesOf({ profiles: [previous] })[0]! : { name };
    if (sameSettings(initial, p) && previous) continue;
    if (previous && !current.has(name)) throw new Error(`Profile ${name} was removed elsewhere; reload before saving.`);
    const next = { ...(current.get(name) ?? { name }) };
    for (const key of profileKeys) {
      if (sameSettings(initial[key], p[key])) continue;
      if (!sameSettings(previous?.[key], next[key]) && !sameSettings(p[key], next[key])) throw new Error(`Profile ${name}.${key} changed elsewhere; reload before saving.`);
      if (p[key] === undefined) delete next[key];
      else next[key] = p[key];
    }
    current.set(name, next);
  }
  return { ...latest, profiles: [...current.values()] };
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
