/** Fixed user-config structures from xai-org/grok-build@2bdd1d6a, checked
 * against stable 1.0.77 on 2026-11-10. Validate without resolving references,
 * running helpers, or inserting the native consumer's defaults.
 */
type Table = Record<string, unknown>;
type Path = string[];
type Fail = (path: Path, reason: string) => never;

function record(value: unknown): value is Table {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateGrokNativeStructures(root: Table, fail: Fail, prefix: Path = []): void {
  function table(value: unknown, path: Path, allowed?: readonly string[]): Table {
    if (!record(value)) fail(path, 'expected a table');
    if (allowed) for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail([...path, key], 'unknown Grok setting');
    }
    return value;
  }
  function string(value: unknown, path: Path, nonblank = false): void {
    if (typeof value !== 'string' || (nonblank && !value.trim())) fail(path, nonblank ? 'required; expected a nonempty string' : 'expected a string');
  }
  function uint(value: unknown, path: Path, min = 0, max = Number.MAX_SAFE_INTEGER): void {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      fail(path, `expected a safe integer in ${min}–${max}`);
    }
  }
  function optionalStrings(value: Table, path: Path, keys: readonly string[]): void {
    for (const key of keys) if (value[key] !== undefined) string(value[key], [...path, key]);
  }
  function optionalBooleans(value: Table, path: Path, keys: readonly string[]): void {
    for (const key of keys) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail([...path, key], 'expected a boolean');
  }
  function array(value: unknown, path: Path): unknown[] {
    if (!Array.isArray(value)) fail(path, 'expected an array');
    return value;
  }
  function stringMap(value: unknown, path: Path): void {
    for (const [key, item] of Object.entries(table(value, path))) string(item, [...path, key]);
  }
  function windows(value: unknown, path: Path): void {
    array(value, path).forEach((item, index) => uint(item, [...path, String(index)], 1));
  }
  function auth(value: unknown, path: Path): void {
    const fields = table(value, path, ['command', 'args', 'cwd', 'token_ttl_secs', 'timeout_secs']);
    string(fields.command, [...path, 'command'], true);
    if (fields.args !== undefined) array(fields.args, [...path, 'args']).forEach((arg, index) => string(arg, [...path, 'args', String(index)]));
    optionalStrings(fields, path, ['cwd']);
    if (fields.token_ttl_secs !== undefined) uint(fields.token_ttl_secs, [...path, 'token_ttl_secs']);
    if (fields.timeout_secs !== undefined) uint(fields.timeout_secs, [...path, 'timeout_secs'], 1, 600);
  }
  for (const [name, provider] of Object.entries(table(root.auth_provider ?? {}, [...prefix, 'auth_provider']))) {
    auth(provider, [...prefix, 'auth_provider', name]);
  }
  for (const [name, provider] of Object.entries(table(root.model_providers ?? {}, [...prefix, 'model_providers']))) {
    const at = [...prefix, 'model_providers', name];
    const fields = table(provider, at, ['base_url', 'api_base_url', 'api_key', 'auth_provider', 'env_key', 'api_backend', 'extra_headers', 'query_params', 'env_http_headers', 'auth', 'context_window', 'context_windows', 'max_request_bytes']);
    optionalStrings(fields, at, ['base_url', 'api_base_url', 'api_key', 'auth_provider']);
    if (fields.env_key !== undefined) {
      if (Array.isArray(fields.env_key)) fields.env_key.forEach((key, index) => string(key, [...at, 'env_key', String(index)]));
      else string(fields.env_key, [...at, 'env_key']);
    }
    if (fields.api_backend !== undefined && (typeof fields.api_backend !== 'string' || !['chat_completions', 'responses', 'messages'].includes(fields.api_backend))) fail([...at, 'api_backend'], 'expected chat_completions, responses or messages');
    for (const key of ['extra_headers', 'query_params', 'env_http_headers']) if (fields[key] !== undefined) stringMap(fields[key], [...at, key]);
    if (fields.auth !== undefined) auth(fields.auth, [...at, 'auth']);
    if (fields.context_window !== undefined) uint(fields.context_window, [...at, 'context_window']);
    if (fields.context_windows !== undefined) windows(fields.context_windows, [...at, 'context_windows']);
    if (fields.max_request_bytes !== undefined) uint(fields.max_request_bytes, [...at, 'max_request_bytes'], 1);
  }
  const sources = record(root.marketplace) ? root.marketplace.sources : undefined;
  if (sources !== undefined) array(sources, [...prefix, 'marketplace', 'sources']).forEach((source, index) => {
    const at = [...prefix, 'marketplace', 'sources', String(index)];
    const fields = table(source, at, ['name', 'path', 'git', 'branch']);
    string(fields.name, [...at, 'name']);
    optionalStrings(fields, at, ['path', 'git', 'branch']);
    if (fields.path === undefined && fields.git === undefined) fail(at, 'marketplace source requires git or path');
  });
  for (const [name, model] of Object.entries(table(root.model ?? {}, [...prefix, 'model']))) {
    const at = [...prefix, 'model', name], fields = table(model, at);
    if (fields.context_windows !== undefined) windows(fields.context_windows, [...at, 'context_windows']);
    if (fields.reasoning_efforts !== undefined) array(fields.reasoning_efforts, [...at, 'reasoning_efforts']).forEach((effort, index) => {
      const path = [...at, 'reasoning_efforts', String(index)];
      const row = typeof effort === 'string' ? null : table(effort, path, ['value', 'id', 'label', 'description', 'default']);
      const value = row ? row.value : effort;
      if (typeof value !== 'string' || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.toLowerCase())) fail(row ? [...path, 'value'] : path, 'expected none, minimal, low, medium, high, xhigh or max (case-insensitive)');
      if (row) {
        optionalStrings(row, path, ['id', 'label', 'description']);
        optionalBooleans(row, path, ['default']);
      }
    });
  }
  for (const [name, server] of Object.entries(table(root.mcp_servers ?? {}, [...prefix, 'mcp_servers']))) {
    if (!record(server) || server.setup === undefined) continue;
    const at = [...prefix, 'mcp_servers', name, 'setup'];
    const setup = table(server.setup, at, ['fields', 'variables', 'values']);
    if (setup.variables !== undefined && setup.values !== undefined) fail([...at, 'values'], 'alias of variables; set only one spelling');
    const fields = array(setup.fields ?? [], [...at, 'fields']);
    if (fields.length !== 1) fail([...at, 'fields'], 'native MCP setup requires exactly one select field');
    const path = [...at, 'fields', '0'];
    const field = table(fields[0], path, ['id', 'label', 'type', 'required', 'default', 'options']);
    string(field.id, [...path, 'id']); string(field.label, [...path, 'label']);
    if (field.type !== 'select') fail([...path, 'type'], 'expected select');
    optionalBooleans(field, path, ['required']); optionalStrings(field, path, ['default']);
    const options = array(field.options ?? [], [...path, 'options']);
    if (!options.length) fail([...path, 'options'], 'native select field requires at least one option');
    options.forEach((option, index) => {
      const here = [...path, 'options', String(index)], item = table(option, here, ['label', 'value']);
      string(item.label, [...here, 'label']); string(item.value, [...here, 'value']);
    });
    const spelling = setup.values !== undefined ? 'values' : 'variables';
    for (const [key, variable] of Object.entries(table(setup[spelling] ?? {}, [...at, spelling]))) {
      const here = [...at, spelling, key], item = table(variable, here, ['from', 'map']);
      string(item.from, [...here, 'from']);
      if (item.from !== field.id) fail([...here, 'from'], 'must reference the configured select field id');
      stringMap(item.map, [...here, 'map']);
    }
  }
  const s3 = record(root.tools) ? root.tools.zdr_video_output_s3 : undefined;
  if (s3 !== undefined) {
    const at = [...prefix, 'tools', 'zdr_video_output_s3'];
    const fields = table(s3, at, ['bucket', 'endpoint', 'region', 'read_write', 'read_only', 'key_prefix', 'expires_secs']);
    for (const key of ['bucket', 'endpoint', 'region']) string(fields[key], [...at, key], true);
    optionalStrings(fields, at, ['key_prefix']);
    if (fields.expires_secs !== undefined) uint(fields.expires_secs, [...at, 'expires_secs'], 480);
    for (const name of ['read_write', 'read_only']) {
      if (name === 'read_only' && fields[name] === undefined) continue;
      const credentials = table(fields[name], [...at, name], ['access_key_id', 'secret_access_key']);
      // Empty read-only credentials intentionally use the native read-write fallback.
      for (const key of ['access_key_id', 'secret_access_key']) string(credentials[key], [...at, name, key], name === 'read_write');
    }
  }
  const gc = record(root.worktree) ? root.worktree.auto_gc : undefined;
  if (gc !== undefined) {
    const at = [...prefix, 'worktree', 'auto_gc'];
    const fields = table(gc, at, ['enabled', 'dry_run', 'include_orphan_snapshots', 'include_rebuild', 'max_age_secs', 'min_interval_secs', 'rebuild_min_interval_secs', 'max_age_by_kind']);
    optionalBooleans(fields, at, ['enabled', 'dry_run', 'include_orphan_snapshots', 'include_rebuild']);
    if (fields.max_age_secs !== undefined) uint(fields.max_age_secs, [...at, 'max_age_secs'], 3600, 7776000);
    for (const key of ['min_interval_secs', 'rebuild_min_interval_secs']) if (fields[key] !== undefined) uint(fields[key], [...at, key], 60, 604800);
    if (fields.max_age_by_kind !== undefined) {
      const ages = table(fields.max_age_by_kind, [...at, 'max_age_by_kind']);
      for (const [kind, age] of Object.entries(ages)) {
        if (!['session', 'ab', 'pool', 'fork', 'manual', 'subagent'].includes(kind.trim().toLowerCase())) fail([...at, 'max_age_by_kind', kind], 'unknown native worktree kind');
        if (typeof age === 'string' && age.toLowerCase() === 'never') continue;
        const parsed = typeof age === 'string' && /^\+?\d+$/.test(age) ? Number(age) : age;
        uint(parsed, [...at, 'max_age_by_kind', kind], 3600, 7776000);
      }
    }
  }
  if (Array.isArray(root.version_overrides)) root.version_overrides.forEach((layer, index) => {
    if (record(layer)) validateGrokNativeStructures(layer, fail, [...prefix, 'version_overrides', String(index)]);
  });
}
