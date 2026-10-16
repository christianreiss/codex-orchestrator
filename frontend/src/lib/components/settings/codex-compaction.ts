type Settings = Record<string, unknown>;
function record(value: unknown): Settings {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Settings : {};
}
function feature(settings: Settings): unknown {
  const native = record(record(settings.native_settings).features).async_compaction;
  const structured = record(settings.features).async_compaction;
  if (structured == null) return native;
  return typeof structured === "object" && typeof native === "object"
    ? { ...record(native), ...record(structured) } : structured;
}
export function codexAsyncCompactionEnabled(settings: Settings): boolean {
  const value = feature(settings);
  return value == null ? true : typeof value === "boolean" ? value : record(value).enabled === true;
}
/** Canonicalize this one control into native JSON, retaining tuning and siblings. */
export function setCodexAsyncCompaction(settings: Settings, enabled: boolean): Settings {
  const current = feature(settings);
  const native = record(settings.native_settings);
  const features = { ...record(settings.features) };
  delete features.async_compaction;
  return { ...settings, features, native_settings: { ...native, features: {
    ...record(native.features), async_compaction: typeof current === "object" && current !== null
      ? { ...record(current), enabled } : enabled,
  } } };
}
