import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ClientConfigService, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';

const flags170 = ['multi_environment_mcp'];
const flags171 = ['catalog_apps_instructions', 'file_backed_tool_audio', 'guardian_nested_approval_context',
  'mcp_shared_repl_cwd', 'per_environment_context', 'restored_history_prewarm', 'safe_image_decoder', 'utc_environment_date'];
const section = { min_total_section_tokens: 0, max_section_entry_tokens: 1, max_total_section_tokens: 2, nested_tool_names: ['shell'] };
const all170 = () => ({
  features: { multi_environment_mcp: true,
    guardianv2: { sync_elastic_sections: { 'section.with.dots': section } } },
  otel: { headers_helper: '/never-run/headers-helper', headers_helper_refresh_interval_ms: 60000 },
});
// Literal dotted section names roundtrip only while budgeting is off: once enabled,
// native Codex accepts only its closed section names (see the elastic suite below).
const all171 = () => ({
  features: { ...Object.fromEntries(flags171.map(key => [key, false])),
    guardianv2: { async_elastic_budgeting: false, async_elastic_sections: { 'async.with.dots': section } },
    multi_agent_v2: { interrupt_at_item_boundary: true },
    token_budget: { context_window_as_tool_output: true },
    rollout_budget: { limit_budget: 2.5, reminder_at_context_start: false, reminder_at_remaining_tokens: [1] },
    network_proxy: { transparent_tcp: true } },
  code_mode: { heartbeat_interval_s: 30 },
  responses: { process_mode: 'after_complete_response' },
  rollout_trace: { max_bytes: 1024, max_payload_bytes: 512 },
  tui: { status_line_provider: { server: 'status.with.dots', tool: 'line' },
    keymap: { composer: { undo: 'ctrl-z', redo: ['ctrl-y'] }, global: { choose_cloud_environment: [] }, pager: { mark_markdown: 'm' } } },
  marketplaces: { 'market.with.dots': { auto_update: true } },
  permissions: { audit: { network: { transparent_tcp: true } } },
});
const all = () => {
  const a = all170(), b = all171();
  return { ...a, ...b, features: { ...a.features, ...b.features, guardianv2: { ...a.features.guardianv2, ...b.features.guardianv2,
    sync_elastic_sections: a.features.guardianv2.sync_elastic_sections } } };
};
const render = (version: string | null, settings: unknown) => renderTomlForHost({ settings,
  host: { clientVersion: version } as never, baseUrl: null, apiKey: null });
const profileOf = (native: unknown) => ({ profiles: [{ name: 'audit', native_settings: native }] });

describe('Codex 0.170/0.171 native settings', () => {
  it('roundtrips, changes and removes root/profile fields with literal names', async () => {
    const service = new ClientConfigService(createDbFake() as never), native = all();
    const stored = await service.store({ settings: { native_settings: native, profiles: [{ name: 'audit', native_settings: native }] } });
    const fetched = await service.adminFetch();
    expect(fetched.settings?.native_settings).toEqual(native);
    expect(fetched.settings?.profiles[0]?.native_settings).toEqual(native);
    for (const content of [stored.content, service.render(fetched.settings).profiles![0]!.content]) {
      expect(content).toContain('[code_mode]');
      expect(content).toContain('heartbeat_interval_s = 30');
      expect(content).toContain('process_mode = "after_complete_response"');
      expect(content).toContain('[rollout_trace]');
      expect(content).toContain('limit_budget = 2.5');
      expect(content).toContain('headers_helper = "/never-run/headers-helper"');
      expect(content).toContain('headers_helper_refresh_interval_ms = 60000');
      expect(content).toContain('[tui.status_line_provider]');
      expect(content).toContain('server = "status.with.dots"');
      expect(content).toContain('[marketplaces."market.with.dots"]');
      expect(content).toContain('auto_update = true');
      expect(content).toContain('[features.guardianv2.sync_elastic_sections."section.with.dots"]');
      expect(content).toContain('[features.guardianv2.async_elastic_sections."async.with.dots"]');
      expect(content).toContain('nested_tool_names = ["shell"]');
      expect(content).toContain('[permissions.audit.network]');
      expect(content).toContain('transparent_tcp = true');
      expect(content).toContain('[features.network_proxy]');
      expect(content).toContain('mark_markdown = "m"');
    }
    const changed = await service.store({ settings: { native_settings: { code_mode: { heartbeat_interval_s: 0 } } }, expected_revision: stored.revision });
    expect(changed.content).toContain('heartbeat_interval_s = 0');
    const removed = await service.store({ settings: { native_settings: {}, profiles: [{ name: 'audit', native_settings: {} }] } });
    expect(removed.content).not.toMatch(/heartbeat_interval_s|rollout_trace|headers_helper|status_line_provider|auto_update|elastic_sections|limit_budget/);
    expect(render(null, {}).content).not.toMatch(/code_mode|headers_helper|multi_environment_mcp|rollout_trace/);
  });

  it('serialises the string form of tui.status_line_provider', () => {
    const content = render('0.171.0', { native_settings: { tui: { status_line_provider: 'default' } } }).content;
    expect(content).toContain('status_line_provider = "default"');
  });

  const added170 = [
    ...flags170.map(key => ({ features: { [key]: false } })),
    { otel: { headers_helper: 'helper' } }, { otel: { headers_helper_refresh_interval_ms: 1 } },
    { features: { guardianv2: { sync_elastic_sections: { s: section } } } },
  ];
  it.each(added170)('gates exact 0.170 root/profile additions: %j', native => {
    for (const settings of [{ native_settings: native }, profileOf(native)]) {
      expect(() => render('0.169.0', settings)).toThrow(/0\.170\.0/);
      expect(() => render(null, settings)).toThrow(/0\.170\.0.*unreported/);
      expect(() => render('0.170.0', settings)).not.toThrow();
      expect(() => render('0.171.0', settings)).not.toThrow();
    }
  });
  const added171 = [
    ...flags171.map(key => ({ features: { [key]: false } })),
    { code_mode: {} }, { code_mode: { heartbeat_interval_s: 1 } },
    { responses: { process_mode: 'streaming' } }, { responses: {} },
    { rollout_trace: {} }, { rollout_trace: { max_bytes: 1 } }, { rollout_trace: { max_payload_bytes: 1 } },
    { tui: { status_line_provider: 'default' } },
    { tui: { status_line_provider: { server: 's', tool: 't' } } },
    { marketplaces: { m: { auto_update: false } } },
    { tui: { keymap: { composer: { undo: [] } } } }, { tui: { keymap: { composer: { redo: [] } } } },
    { tui: { keymap: { global: { choose_cloud_environment: [] } } } },
    { tui: { keymap: { pager: { mark_markdown: [] } } } },
    { features: { guardianv2: { async_elastic_budgeting: false } } },
    { features: { guardianv2: { async_elastic_sections: {} } } },
    { features: { guardianv2: { async_elastic_sections: { s: section } } } },
    { features: { multi_agent_v2: { interrupt_at_item_boundary: false } } },
    { features: { token_budget: { context_window_as_tool_output: false } } },
    { features: { rollout_budget: { limit_budget: 1 } } },
    { features: { rollout_budget: { reminder_at_context_start: false } } },
    { features: { network_proxy: { transparent_tcp: false } } },
    { permissions: { audit: { network: { transparent_tcp: false } } } },
  ];
  it.each(added171)('gates exact 0.171 root/profile additions: %j', native => {
    for (const settings of [{ native_settings: native }, profileOf(native)]) {
      for (const version of ['0.169.0', '0.170.0']) expect(() => render(version, settings)).toThrow(/0\.171\.0/);
      expect(() => render(null, settings)).toThrow(/0\.171\.0.*unreported/);
      expect(() => render('0.171.0', settings)).not.toThrow();
    }
  });
  it('requires the higher floor when both generations are authored and gates structured profile features', () => {
    expect(() => render('0.170.0', { native_settings: all() })).toThrow(/0\.171\.0/);
    expect(() => render('0.171.0', { native_settings: all() })).not.toThrow();
    expect(() => render('0.170.0', { profiles: [{ name: 'audit', features: { safe_image_decoder: true } }] })).toThrow(/0\.171\.0/);
  });
  it('keeps opaque names and earlier floors untouched', () => {
    expect(() => render('0.162.1', { native_settings: { mcp_servers: { 'features.safe_image_decoder': { command: '/bin/false' },
      'otel.headers_helper': { command: '/bin/false' } }, model_providers: { 'code_mode.heartbeat_interval_s': { name: 'Audit' } },
      plugins: { 'auto_update': { enabled: true } } } })).not.toThrow();
    // 0.169-era authoring keeps its floor.
    expect(() => render('0.169.0', { native_settings: { tui: { collapse_turn_details: true }, features: { gateway_setup_wizard: false } } })).not.toThrow();
    expect(() => render('0.168.0', { native_settings: { tui: { collapse_turn_details: true } } })).toThrow(/0\.169\.0/);
  });

  it.each([
    { code_mode: { heartbeat_interval_s: -1 } }, { code_mode: { heartbeat_interval_s: 1.5 } }, { code_mode: { unknown: 1 } },
    { responses: { process_mode: 'unknown' } }, { responses: { unknown: 1 } },
    { rollout_trace: { max_bytes: -1 } }, { rollout_trace: { unknown: 1 } },
    { tui: { status_line_provider: 'custom' } }, { tui: { status_line_provider: { server: 's' } } },
    { tui: { status_line_provider: { server: 's', tool: 't', extra: 1 } } },
    { marketplaces: { m: { auto_update: 'yes' } } },
    { otel: { headers_helper_refresh_interval_ms: 0 } }, { otel: { headers_helper: 1 } },
    { features: { rollout_budget: { limit_budget: 0 } } }, { features: { rollout_budget: { limit_budget: 'many' } } },
    { features: { guardianv2: { async_elastic_sections: { s: { nested_tool_names: [1] } } } } },
    { features: { guardianv2: { async_elastic_sections: { s: { max_section_entry_tokens: 1 } } } } },
    { tui: { keymap: { composer: { undo: 'not a key !' } } } },
    { features: { safe_image_decoder: 'yes' } },
  ])('rejects invalid new types/ranges/required fields: %j', native => {
    expect(() => normalizeCodexNativeSettings(native)).toThrow();
  });
});

describe('Codex 0.171 rollout_budget semantics', () => {
  const budget = (fields: Record<string, unknown>) => ({ features: { rollout_budget: fields } });
  it('accepts limit_budget alone and still accepts limit_tokens alone', () => {
    expect(() => normalizeCodexNativeSettings(budget({ enabled: true, limit_budget: 100.5, reminder_at_remaining_tokens: [10] }))).not.toThrow();
    expect(() => normalizeCodexNativeSettings(budget({ enabled: true, limit_tokens: 100, reminder_at_remaining_tokens: [10] }))).not.toThrow();
    expect(() => normalizeCodexNativeSettings(budget({ limit_budget: 100 }))).not.toThrow();
  });
  it.each([true, false, undefined])('rejects limit_tokens together with limit_budget (enabled=%s)', enabled => {
    expect(() => normalizeCodexNativeSettings(budget({ ...(enabled === undefined ? {} : { enabled }), limit_tokens: 100, limit_budget: 100,
      reminder_at_remaining_tokens: [10] }))).toThrow(/limit_tokens and limit_budget cannot both be set/);
  });
  it('requires an allowance and reminder thresholds when enabled', () => {
    expect(() => normalizeCodexNativeSettings(budget({ enabled: true, reminder_at_remaining_tokens: [10] })))
      .toThrow(/rollout_budget\.limit_tokens or limit_budget is required/);
    expect(() => normalizeCodexNativeSettings(budget({ enabled: true, limit_budget: 100 })))
      .toThrow(/rollout_budget\.reminder_at_remaining_tokens is required/);
    expect(() => normalizeCodexNativeSettings(budget({ enabled: true, limit_tokens: 100 })))
      .toThrow(/rollout_budget\.reminder_at_remaining_tokens is required/);
  });
  it('rejects conflicting allowances across structured and native layers once merged', () => {
    const service = new ClientConfigService({} as never);
    const native_settings = { features: { rollout_budget: { limit_tokens: 1000, reminder_at_remaining_tokens: [100] } } };
    expect(() => service.render({ native_settings, features: { rollout_budget: { limit_budget: 5 } } })).toThrow(/cannot both be set/);
    expect(() => service.render({ native_settings: { features: { rollout_budget: { limit_budget: 5, reminder_at_remaining_tokens: [1] } } },
      features: { rollout_budget: { enabled: true } } })).not.toThrow();
  });
});

// Native resolve_elastic_budget (core config, rust-v0.170.0/0.171.0) and guardian-context
// budget.rs. Omitted sections keep native minimums 5000 + 1000 + 0 + 11 × 900 = 15900.
const limits = (min: number, entry: number, extra: Record<string, unknown> = {}) =>
  ({ min_total_section_tokens: min, max_section_entry_tokens: entry, ...extra });
const validSections = () => ({ transcript_messages: limits(117100, 9000) });
const selectedSections = (names: unknown[] | undefined) => ({ transcript_messages: limits(116100, 9000),
  transcript_selected_exec_results: limits(1000, 1000, names === undefined ? {} : { nested_tool_names: names }) });
const otherSections = ['root_conversation_messages', 'retained_user_instructions', 'trusted_user_answers', 'sender_user_messages',
  'planned_action', 'previous_reviews', 'trusted_tools', 'trusted_skills', 'transcript_images', 'node_repl_evidence'];
type ElasticSpec = { budgeting?: boolean; sections?: Record<string, unknown>; guardian?: Record<string, unknown> };
const elasticGuardian = (side: 'sync' | 'async', spec: ElasticSpec) => ({ ...spec.guardian,
  ...(spec.budgeting !== undefined && { [`${side}_elastic_budgeting`]: spec.budgeting }),
  ...(spec.sections !== undefined && { [`${side}_elastic_sections`]: spec.sections }) });
const ok = null;
const S = (rest: string) => `features\\.guardianv2\\.SIDE_elastic_sections${rest}`;
// [name, spec, sync result, async result]: null accepts, otherwise the expected error pattern.
const elasticCases: Array<[string, ElasticSpec, string | null, string | null]> = [
  ['default minimums plus one widened section', { budgeting: true, sections: validSections() }, ok, ok],
  ['a native alias replacing its canonical default', { budgeting: true, sections: { ...validSections(), root_messages: limits(900, 900) } }, ok, ok],
  ['every canonical section except selected exec results', { budgeting: true, sections: { transcript_messages: limits(5000, 5000),
    transcript_tools: limits(1000, 1000), ...Object.fromEntries(otherSections.map(name => [name, limits(9000, 900)])),
    permission_context: limits(32000, 900) } }, ok, ok],
  ['six aliases', { budgeting: true, sections: { transcript_messages: limits(110800, 9000), retained_instructions: limits(900, 900),
    user_answers: limits(900, 900), sender_messages: limits(900, 900), images: limits(900, 900), repl_evidence: limits(7200, 900) } }, ok, ok],
  ['maximums outside the sum', { budgeting: true, sections: { transcript_messages: limits(117100, 9000, { max_total_section_tokens: 500000 }) } }, ok, ok],
  ['maximum equal to minimum', { budgeting: true, sections: { transcript_messages: limits(117100, 9000, { max_total_section_tokens: 117100 }) } }, ok, ok],
  ['entry cap equal to minimum', { budgeting: true, sections: { transcript_messages: limits(116100, 9000), transcript_tools: limits(2000, 2000) } }, ok, ok],
  ['empty nested_tool_names on another section', { budgeting: true, sections: { transcript_messages: limits(117100, 9000, { nested_tool_names: [] }) } }, ok, ok],
  ['selected exec results with tool names', { budgeting: true, sections: selectedSections(['exec']) }, ok, S('\\.transcript_selected_exec_results: only supported for sync')],
  ['a BOM tool name, which Rust does not trim', { budgeting: true, sections: selectedSections(['﻿']) }, ok, S('\\.transcript_selected_exec_results: only supported for sync')],
  ['disabled budgeting with invalid sections', { budgeting: false, sections: { 'section.with.dots': limits(0, 9001, { max_total_section_tokens: 0, nested_tool_names: [''] }) } }, ok, ok],
  ['omitted budgeting with invalid sections', { sections: { bogus: limits(0, 9001, { nested_tool_names: [' '] }) } }, ok, ok],
  ['disabled selected exec results without names', { budgeting: false, sections: { transcript_selected_exec_results: limits(1, 1) } }, ok, ok],
  ['enabled without sections', { budgeting: true }, S(': at least one section is required when SIDE_elastic_budgeting is enabled'), 'same'],
  ['enabled with an empty section map', { budgeting: true, sections: {} }, S(': at least one section is required'), 'same'],
  ['an unknown section', { budgeting: true, sections: { bogus: limits(117100, 9000) } }, S('\\.bogus: unknown elastic section'), 'same'],
  ['a literal dotted name', { budgeting: true, sections: { 'section.with.dots': limits(117100, 9000) } }, S('\\.section\\.with\\.dots: unknown elastic section'), 'same'],
  ['a wrong-case section', { budgeting: true, sections: { Transcript_Messages: limits(117100, 9000) } }, S('\\.Transcript_Messages: unknown elastic section'), 'same'],
  ['an inherited property name', { budgeting: true, sections: { ...validSections(), toString: limits(900, 900) } }, S('\\.toString: unknown elastic section'), 'same'],
  ['an alias next to its canonical name', { budgeting: true, sections: { ...validSections(), root_messages: limits(900, 900),
    root_conversation_messages: limits(900, 900) } }, S('\\.root_messages: duplicates the root_conversation_messages section'), 'same'],
  ['two aliases of one section', { budgeting: true, sections: { ...validSections(), tool_descriptions: limits(900, 900),
    planned_action_tool_descriptions: limits(900, 900) } }, S('\\.tool_descriptions: duplicates the planned_action section'), 'same'],
  ['minimums one above the budget', { budgeting: true, sections: { transcript_messages: limits(117101, 9000) } }, S(': section minimums .* must sum to exactly 128000.*got 128001'), 'same'],
  ['minimums one below the budget', { budgeting: true, sections: { transcript_messages: limits(117099, 9000) } }, S(': section minimums .* must sum to exactly 128000.*got 127999'), 'same'],
  ['a maximum below its minimum', { budgeting: true, sections: { transcript_messages: limits(117100, 9000, { max_total_section_tokens: 117099 }) } },
    S('\\.transcript_messages\\.max_total_section_tokens: must be at least min_total_section_tokens'), 'same'],
  ['an entry cap above the delivery limit', { budgeting: true, sections: { transcript_messages: limits(117100, 9001) } },
    S('\\.transcript_messages\\.max_section_entry_tokens: must not exceed 9000'), 'same'],
  ['a zero entry cap', { budgeting: true, sections: { transcript_messages: limits(117100, 0) } },
    S('\\.transcript_messages\\.max_section_entry_tokens: must be greater than zero'), 'same'],
  ['a zero minimum', { budgeting: true, sections: { ...validSections(), transcript_tools: limits(0, 1) } },
    S('\\.transcript_tools\\.min_total_section_tokens: must be greater than zero'), 'same'],
  ['an entry cap above its minimum', { budgeting: true, sections: { transcript_messages: limits(116200, 9000), transcript_tools: limits(1900, 2000) } },
    S('\\.transcript_tools\\.max_section_entry_tokens: must not exceed min_total_section_tokens'), 'same'],
  ['nested_tool_names on another section', { budgeting: true, sections: { transcript_messages: limits(117100, 9000, { nested_tool_names: ['shell'] }) } },
    S('\\.transcript_messages\\.nested_tool_names: only supported for transcript_selected_exec_results'), 'same'],
  ['selected exec results without tool names', { budgeting: true, sections: selectedSections(undefined) },
    S('\\.transcript_selected_exec_results\\.nested_tool_names: requires nonblank tool names'), S('\\.transcript_selected_exec_results: only supported for sync')],
  ['selected exec results with an empty name list', { budgeting: true, sections: selectedSections([]) },
    S('\\.transcript_selected_exec_results\\.nested_tool_names: requires nonblank tool names'), S('\\.transcript_selected_exec_results: only supported for sync')],
  ['selected exec results with a blank name', { budgeting: true, sections: selectedSections(['exec', '  ']) },
    S('\\.transcript_selected_exec_results\\.nested_tool_names: requires nonblank tool names'), S('\\.transcript_selected_exec_results: only supported for sync')],
  ['selected exec results with a NEL name, which Rust trims', { budgeting: true, sections: selectedSections(['\u0085']) },
    S('\\.transcript_selected_exec_results\\.nested_tool_names: requires nonblank tool names'), S('\\.transcript_selected_exec_results: only supported for sync')],
  ['Guardian disabled does not disable the budget check', { guardian: { enabled: false }, budgeting: true, sections: { bogus: limits(117100, 9000) } },
    S('\\.bogus: unknown elastic section'), 'same'],
];
const elasticRows = elasticCases.flatMap(([name, spec, sync, async]) => (['sync', 'async'] as const).map(side => {
  const source = side === 'sync' ? sync : async === 'same' ? sync : async;
  return { name, side, spec, error: source === null ? null : new RegExp(source.replaceAll('SIDE', side)) };
}));
const elasticNative = (side: 'sync' | 'async', spec: ElasticSpec) => ({ features: { guardianv2: elasticGuardian(side, spec) } });

describe('Codex 0.170/0.171 Guardian elastic budgeting semantics', () => {
  it.each(elasticRows)('$side: $name', ({ side, spec, error }) => {
    const check = () => normalizeCodexNativeSettings(elasticNative(side, spec));
    if (error === null) expect(check).not.toThrow();
    else expect(check).toThrow(new RegExp(`^native_settings\\.${error.source}`));
  });

  it('enforces the rules at root and profile store, then stores and removes a valid budget', async () => {
    const service = new ClientConfigService(createDbFake() as never);
    const bad = elasticNative('async', { budgeting: true, sections: { bogus: limits(117100, 9000) } });
    const good = { features: { guardianv2: { sync_elastic_budgeting: true, sync_elastic_sections: selectedSections(['exec']),
      async_elastic_budgeting: true, async_elastic_sections: validSections() } } };
    await expect(service.store({ settings: { native_settings: bad } })).rejects.toThrow(/async_elastic_sections\.bogus: unknown elastic section/);
    await expect(service.store({ settings: { profiles: [{ name: 'audit', native_settings: bad }] } }))
      .rejects.toThrow(/async_elastic_sections\.bogus: unknown elastic section/);
    const stored = await service.store({ settings: { native_settings: good, profiles: [{ name: 'audit', native_settings: good }] } });
    for (const content of [stored.content, service.render((await service.adminFetch()).settings).profiles![0]!.content]) {
      expect(content).toContain('sync_elastic_budgeting = true');
      expect(content).toContain('async_elastic_budgeting = true');
      expect(content).toContain('[features.guardianv2.sync_elastic_sections.transcript_selected_exec_results]');
      expect(content).toContain('nested_tool_names = ["exec"]');
    }
    const removed = await service.store({ settings: { native_settings: {}, profiles: [] }, expected_revision: stored.revision });
    expect(removed.content).not.toContain('elastic');
  });

  it('checks the merged document: structured switches over native sections', () => {
    const service = new ClientConfigService({} as never);
    const on = { guardianv2: { sync_elastic_budgeting: true } };
    expect(() => service.render({ native_settings: { features: { guardianv2: { sync_elastic_sections: { bogus: limits(1, 1) } } } }, features: on }))
      .toThrow(/sync_elastic_sections\.bogus: unknown elastic section/);
    expect(() => service.render({ native_settings: { features: { guardianv2: { sync_elastic_sections: validSections() } } }, features: on })).not.toThrow();
    // Like rollout_budget, native_settings must also be a loadable document on its own.
    expect(() => service.render({ native_settings: { features: { guardianv2: { sync_elastic_budgeting: true, sync_elastic_sections: { bogus: limits(1, 1) } } } },
      features: { guardianv2: { sync_elastic_budgeting: false } } })).toThrow(/sync_elastic_sections\.bogus: unknown elastic section/);
  });

  it('keeps selected exec results behind the existing 0.170 floor', () => {
    const native = elasticNative('sync', { budgeting: true, sections: selectedSections(['exec']) });
    expect(() => render('0.169.0', { native_settings: native })).toThrow(/0\.170\.0/);
    expect(() => render('0.170.0', { native_settings: native })).not.toThrow();
    expect(() => render('0.168.0', { native_settings: elasticNative('sync', { budgeting: true, sections: validSections() }) })).not.toThrow();
  });

  it('keeps an invalid historical budget editable with a field error, preserving its body', async () => {
    const db = createDbFake(), service = new ClientConfigService(db as never);
    const stored = await service.store({ settings: { native_settings: elasticNative('sync', { budgeting: true, sections: validSections() }) } });
    const row = db.tables.get(clientConfigDocuments)!.at(-1)!;
    const authored = { native_settings: elasticNative('sync', { budgeting: true, sections: { transcript_messages: limits(117101, 9000) } }) };
    row.settings = authored;
    const fetched = await service.adminFetch();
    expect(fetched.settings).toEqual(authored);
    expect(fetched.revision).toBe(stored.revision);
    expect(fetched.content).toBe(stored.content);
    expect(fetched.validation_error?.param).toBe('native_settings.features.guardianv2.sync_elastic_sections');
    expect(fetched.validation_error?.message).toMatch(/sum to exactly 128000.*got 128001/);
    expect(row.settings).toEqual(authored);
    expect(() => render('0.171.0', authored)).toThrow(/sync_elastic_sections: section minimums/);
  });
});

// Raw TOML keeps the native oracle independent of the central renderer.
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, item]) => `${toml(key)} = ${toml(item)}`).join(', ')} }`;
  return JSON.stringify(value).replace(/[\u007f-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
describe.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('Codex actual Guardian elastic budget loader', () => {
  it('accepts and rejects exactly the central case table', () => {
    const bin = process.env.CODEX_NATIVE_TEST_BIN!;
    const home = mkdtempSync(join(tmpdir(), 'codex-elastic-oracle-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(home, 'home'), CODEX_HOME: home };
    mkdirSync(env.HOME);
    try {
      const version = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 15000 }).stdout;
      // Async elastic budgeting is a 0.171 key; 0.170 still checks the sync side.
      const sides = /\b0\.170\./.test(version) ? ['sync'] : ['sync', 'async'];
      for (const { name, side, spec, error } of elasticRows.filter(row => sides.includes(row.side))) {
        writeFileSync(join(home, 'config.toml'), `[features]\nguardianv2 = ${toml(elasticGuardian(side, spec))}\n`);
        const probe = spawnSync(bin, ['features', 'list'], { env, encoding: 'utf8', timeout: 15000 });
        expect(probe.error).toBeUndefined();
        expect(probe.status, `${side}: ${name}\n${probe.stderr}`).toBe(error === null ? 0 : 1);
        if (error !== null) expect(probe.stderr).toContain('failed to load configuration');
        expect(existsSync(join(home, 'auth.json'))).toBe(false);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('Codex 0.171 actual parser', () => {
  // The native loader requires a default when [permissions] profiles exist.
  const parserNative = () => ({ ...all(), default_permissions: 'audit' });
  const elasticProfile = { features: { guardianv2: { sync_elastic_budgeting: true, sync_elastic_sections: selectedSections(['exec']),
    async_elastic_budgeting: true, async_elastic_sections: { ...validSections(), root_messages: limits(900, 900, { max_total_section_tokens: 4000 }) } } } };
  it.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('loads rendered root/profile without auth or running helpers', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-171-parser-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(home, 'home'), CODEX_HOME: home };
    mkdirSync(env.HOME);
    try {
      const result = new ClientConfigService({} as never).render({ native_settings: parserNative(),
        profiles: [{ name: 'audit', native_settings: parserNative() }, { name: 'elastic', native_settings: elasticProfile }] });
      expect(result.profiles).toHaveLength(2);
      for (const content of [result.content, ...result.profiles!.map(profile => profile.content)]) {
        writeFileSync(join(home, 'config.toml'), content);
        const probe = spawnSync(process.env.CODEX_NATIVE_TEST_BIN!, ['features', 'list'], { env, encoding: 'utf8', timeout: 15000 });
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stderr).not.toMatch(/failed to load|Error loading/);
        for (const key of [...flags170, ...flags171]) expect(probe.stdout).toMatch(new RegExp(`^${key}\\s.*(true|false)\\s*$`, 'm'));
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
