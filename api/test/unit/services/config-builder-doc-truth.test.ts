import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToml } from '../../../src/services/client-config.js';
import { CODEX_WEB_SEARCH_VALUES } from '../../../src/services/agent-security-levels.js';
import {
  APPROVAL_POLICIES,
  DROPPED_FEATURE_KEYS,
  PERSONALITIES,
  normalizeSettings,
} from '../../../src/services/config-normalizer.js';

/**
 * `docs/CONFIG_BUILDER.md` is what operators read before editing fleet
 * `config.toml`, so a wrong value set there produces settings the normalizer
 * silently discards. It had drifted on every value list at once: `web_search`
 * was documented as `live`/`cached`/`disabled` (it is a boolean), `on-failure`
 * was said to be rewritten to `on-request` (it is kept verbatim), and the
 * feature textarea was said to keep only supported flags (the normalizer is a
 * denylist).
 *
 * This scan reads the backticked value lists out of the doc and compares them
 * against the exported constants, and runs the documented `web_search` shape
 * through `normalizeSettings` itself.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(HERE, '../../../../docs/CONFIG_BUILDER.md');

/**
 * A value-list bullet: a fixed label, then backticked values to the end of the
 * line. Prose lives on its own bullets, so a sentence mentioning `on-request`
 * or `true` never reads as part of a value set.
 */
const VALUE_LINE = /^- (Accepted values|Dropped feature keys): (`[a-z0-9_-]+`(?:, `[a-z0-9_-]+`)*)\.$/;
const VALUE_SPAN = /`([a-z0-9_-]+)`/g;

/** The values on the labelled bullet inside the `## <heading>` section. */
function docValues(heading: string, label: string): string[] {
  let section: string | null = null;
  for (const line of readFileSync(DOC, 'utf8').split('\n')) {
    if (line.startsWith('## ')) section = line.slice(3).trim();
    if (section !== heading) continue;
    const bullet = VALUE_LINE.exec(line);
    if (!bullet || bullet[1] !== label) continue;
    return [...bullet[2]!.matchAll(VALUE_SPAN)].map((span) => span[1]!);
  }
  return [];
}

const personalities = docValues('Communication style', 'Accepted values');
const approvalPolicies = docValues('Approval policy values', 'Accepted values');
const droppedFeatureKeys = docValues('Feature switches', 'Dropped feature keys');
const webSearchValues = docValues('Web search toggle', 'Accepted values');

describe('docs/CONFIG_BUILDER.md value sets', () => {
  it('extracts the lists it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertions below.
    expect(personalities.length).toBeGreaterThan(0);
    expect(approvalPolicies.length).toBeGreaterThan(0);
    expect(droppedFeatureKeys.length).toBeGreaterThan(0);
    expect(webSearchValues.length).toBeGreaterThan(0);
  });

  it('documents the personalities the normalizer accepts', () => {
    expect(personalities).toEqual([...PERSONALITIES]);
  });

  it('documents the approval policies the normalizer accepts', () => {
    expect(approvalPolicies).toEqual([...APPROVAL_POLICIES]);
    // The doc used to promise a rewrite the normalizer never performed.
    expect(normalizeSettings({ approval_policy: 'on-failure' }).approval_policy).toBe('on-failure');
  });

  it('documents the feature keys the normalizer drops', () => {
    expect(droppedFeatureKeys).toEqual([...DROPPED_FEATURE_KEYS]);
  });

  it('documents the denylist as a denylist', () => {
    const s = normalizeSettings({ features: { memories: true, some_new_codex_flag: true } });
    expect(s.features).toEqual({ memories: true, some_new_codex_flag: true });
    expect(renderToml(s)).toContain('some_new_codex_flag = true');
  });
});

describe('docs/CONFIG_BUILDER.md web_search shape', () => {
  it('documents exactly the enum Codex accepts', () => {
    expect(webSearchValues).toEqual([...CODEX_WEB_SEARCH_VALUES]);
    for (const value of webSearchValues) {
      expect(normalizeSettings({ web_search: value }).web_search).toBe(value);
      expect(renderToml(normalizeSettings({ web_search: value }))).toContain(
        `web_search = "${value}"`,
      );
    }
  });

  // Verified against codex-cli 0.146.0: a boolean here is not a bad value for
  // one key, it makes Codex refuse to load config.toml at all
  // ("invalid type: unit variant, expected string only in web_search"). So a
  // boolean must never survive normalization into the rendered output.
  it('never renders a boolean, whatever a stored document holds', () => {
    for (const legacy of [true, 1, 'true', 'yes', 'on']) {
      expect(normalizeSettings({ web_search: legacy }).web_search).toBe('live');
    }
    for (const legacy of [false, 0, 'false', 'no', 'off']) {
      expect(normalizeSettings({ web_search: legacy }).web_search).toBe('disabled');
    }
    for (const legacy of [true, false, 1, 0, 'yes', 'off']) {
      expect(renderToml(normalizeSettings({ web_search: legacy }))).not.toContain('web_search = true');
      expect(renderToml(normalizeSettings({ web_search: legacy }))).not.toContain('web_search = false');
    }
  });

  it('omits the key for an unknown or absent value', () => {
    for (const junk of ['sometimes', 'LIVE?', 42, {}]) {
      const s = normalizeSettings({ web_search: junk });
      expect(s.web_search).toBeNull();
      expect(renderToml(s)).not.toContain('web_search');
    }
    expect(normalizeSettings({}).web_search).toBeNull();
  });

  it('drops the legacy feature keys instead of promoting them to the root', () => {
    const s = normalizeSettings({
      features: { web_search: true, web_search_request: true, web_search_cached: true },
    });
    expect(s.web_search).toBeNull();
    expect(s.features).toEqual({});
  });
});
