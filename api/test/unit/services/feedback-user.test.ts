import { describe, expect, it, vi } from 'vitest';
import { classifyVersion } from '../../../src/services/feedback/build-identity.js';
import { FeedbackGithub, sensitiveText } from '../../../src/services/feedback/github.js';
import { probeValue, searchTerms } from '../../../src/services/feedback/worker.js';
import { configSchema, probeSchema } from '../../../src/services/feedback/contract.js';

describe('user feedback trust boundaries', () => {
  it('requires a clean, full baked SHA and never treats an unknown build as recent', () => {
    const sha = 'a'.repeat(40);
    expect(classifyVersion({ commit: null, dirty: false }, sha)).toBe('unknown');
    expect(classifyVersion({ commit: sha, dirty: true }, sha)).toBe('unknown');
    expect(classifyVersion({ commit: sha, dirty: false }, sha)).toBe('recent');
    expect(classifyVersion({ commit: 'b'.repeat(40), dirty: false }, sha)).toBe('old_version');
  });
  it('rejects arbitrary URLs, commands and prototype paths in API assertions', () => {
    expect(probeSchema.safeParse({ endpoint: 'https://internal/', pointer: '/ok', equals: true }).success).toBe(false);
    expect(probeSchema.safeParse({ endpoint: 'health', pointer: '/ok', equals: true, command: 'anything' }).success).toBe(false);
    expect(probeValue({ data: { ok: true } }, '/data/ok')).toBe(true);
    expect(probeValue({}, '/__proto__')).toBeUndefined();
    expect(probeValue({}, '/constructor/name')).toBeUndefined();
  });
  it('requires explicit engine/model selection for automatic AI checks', () => {
    expect(configSchema.safeParse({ mode: 'user', auto_publish: false, runner_enabled: true, engine: null, model: null }).success).toBe(false);
  });
  it('uses independent search terms rather than requiring an identical title', () => {
    expect(searchTerms({ title: 'Wrapper manifest parser silently fails', component: 'wrapper' })).toEqual(['Wrapper manifest', 'parser silently']);
  });
  it.each(['password=hunter2', 'Bearer example-token', '/home/operator/report.txt', 'user@example.test', '192.168.1.2', 'service.internal', `ghp_${'x'.repeat(30)}`])('holds private text: %s', (text) => {
    expect(sensitiveText(text)).toBe(true);
  });
  it('allows a public reproduction with a software version', () => {
    expect(sensitiveText('GET /healthz returns false instead of true on cxx 0.9.31')).toBe(false);
  });
  it('does not turn incomplete GitHub searches into an empty match set', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ incomplete_results: true, total_count: 0, items: [] })));
    await expect(new FeedbackGithub(null, request).search('manifest parser')).rejects.toMatchObject({ code: 'github_incomplete' });
  });
  it('reads every search page and includes closed issues', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ incomplete_results: false, total_count: 2, items: [{ number: 1, state: 'closed' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ incomplete_results: false, total_count: 2, items: [{ number: 2, state: 'open' }] })));
    expect((await new FeedbackGithub(null, request).search('manifest parser')).map((i) => i.number)).toEqual([1, 2]);
    expect(String(request.mock.calls[0]![0])).not.toContain('state%3Aopen');
  });
  it('never posts a private payload or without a GitHub connection', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(new FeedbackGithub(null, request).publish('Bug', 'A reproduction', null)).rejects.toMatchObject({ code: 'github_not_connected' });
    await expect(new FeedbackGithub('fixture', request).publish('Bug', 'password=hunter2', null)).rejects.toMatchObject({ code: 'privacy_review_required' });
    expect(request).not.toHaveBeenCalled();
  });
  it('distinguishes a definite GitHub rejection from a lost publication response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(new FeedbackGithub('fixture', request).publish('API bug', 'Reproduction details', null))
      .rejects.toMatchObject({ code: 'github_publication_rejected' });
  });
});
