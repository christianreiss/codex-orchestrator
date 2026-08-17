import { describe, expect, it } from 'vitest';
import {
  assertControlsSupported,
  capabilitiesFor,
  stopReasonFor,
  UnsupportedControlError,
  type GenerationControl,
} from '../../../src/services/transport-capabilities.js';

/**
 * The compat gateways accepted `temperature`, `top_p`, `top_k` and
 * `stop_sequences`, forwarded them to the runner, and the runner handed them to
 * neither CLI. `docs/auth-runner.md` said as much — "accepted for wire-format
 * compatibility and reach neither CLI" — which recorded the behaviour without
 * making it acceptable. A caller setting `temperature: 0` to get a
 * deterministic classification received a sampled answer with no signal that
 * its instruction had been dropped.
 */

const CODEX = capabilitiesFor('runner-cli', 'codex');
const CLAUDE = capabilitiesFor('runner-cli', 'claude');

describe('the CLI transport declares what it can actually honor', () => {
  it('enforces only the controls a CLI invocation has room for', () => {
    expect(CODEX.controls.model).toBe('enforced');
    expect(CLAUDE.controls.model).toBe('enforced');
    // The runner writes `system` into the Claude invocation; `codex exec` has
    // nowhere to put it.
    expect(CLAUDE.controls.system).toBe('enforced');
    expect(CODEX.controls.system).toBe('unsupported');
  });

  it('marks every sampling control unsupported on both engines', () => {
    for (const capabilities of [CODEX, CLAUDE]) {
      for (const control of ['temperature', 'top_p', 'top_k', 'stop_sequences'] as const) {
        expect(capabilities.controls[control]).toBe('unsupported');
      }
    }
  });

  it('accepts max_tokens without claiming to enforce it', () => {
    // Anthropic's Messages API requires the field on every request, so
    // rejecting it would break the official SDK against this surface. It is
    // labelled honestly instead, and nothing may report a `max_tokens` stop.
    expect(CODEX.controls.max_tokens).toBe('accepted-unenforceable');
    expect(CLAUDE.controls.max_tokens).toBe('accepted-unenforceable');
  });

  it('does not claim a stop reason or exact Codex usage it cannot produce', () => {
    expect(CODEX.reportsStopReason).toBe(false);
    expect(CLAUDE.reportsStopReason).toBe(false);
    expect(CODEX.reportsExactUsage).toBe(false);
    // The Claude CLI's JSON result carries real token counts.
    expect(CLAUDE.reportsExactUsage).toBe(true);
  });
});

describe('assertControlsSupported', () => {
  it('permits a request that supplies nothing unsupported', () => {
    expect(() => assertControlsSupported({}, CLAUDE)).not.toThrow();
    expect(() =>
      assertControlsSupported({ max_tokens: 1024, system: 'be brief', model: 'x' }, CLAUDE),
    ).not.toThrow();
  });

  it.each(['temperature', 'top_p', 'top_k', 'stop_sequences'] as GenerationControl[])(
    'refuses %s rather than dropping it silently',
    (control) => {
      const supplied = { [control]: control === 'stop_sequences' ? ['END'] : 0.5 };
      expect(() => assertControlsSupported(supplied, CLAUDE)).toThrow(UnsupportedControlError);
    },
  );

  it('refuses a system prompt on the Codex path, which cannot carry one', () => {
    expect(() => assertControlsSupported({ system: 'be brief' }, CODEX)).toThrow(
      UnsupportedControlError,
    );
    expect(() => assertControlsSupported({ system: 'be brief' }, CLAUDE)).not.toThrow();
  });

  it('treats an absent or empty control as not supplied', () => {
    expect(() =>
      assertControlsSupported(
        { temperature: undefined, top_p: null, stop_sequences: [] },
        CLAUDE,
      ),
    ).not.toThrow();
  });

  it('refuses temperature 0, which is the case that mattered most', () => {
    // `0` is falsy and a deliberate, meaningful value: a caller asking for
    // determinism. A presence check written as `if (params.temperature)` would
    // have let exactly this one through.
    expect(() => assertControlsSupported({ temperature: 0 }, CLAUDE)).toThrow(
      UnsupportedControlError,
    );
  });

  it('names every unsupported control at once so one round trip fixes the request', () => {
    let caught: UnsupportedControlError | null = null;
    try {
      assertControlsSupported({ temperature: 0.2, top_k: 40, top_p: 0.9 }, CLAUDE);
    } catch (err) {
      caught = err as UnsupportedControlError;
    }
    expect(caught).toBeInstanceOf(UnsupportedControlError);
    expect(caught?.status).toBe(400);
    expect(caught?.code).toBe('unsupported_generation_control');
    const body = caught?.toJSON() as { unsupported?: string[] };
    expect(body.unsupported).toEqual(['temperature', 'top_k', 'top_p']);
  });

  it('is a client error, not a retriable server one', () => {
    // Repeating the identical request fails identically; a 5xx would invite an
    // SDK to retry it forever.
    try {
      assertControlsSupported({ temperature: 1 }, CODEX);
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as UnsupportedControlError;
      expect(error.status).toBeGreaterThanOrEqual(400);
      expect(error.status).toBeLessThan(500);
    }
  });
});

describe('stopReasonFor', () => {
  it('reports null when the backend said nothing, instead of asserting "stop"', () => {
    expect(stopReasonFor(CODEX, undefined)).toBeNull();
    expect(stopReasonFor(CODEX, null)).toBeNull();
    expect(stopReasonFor(CLAUDE, '')).toBeNull();
    expect(stopReasonFor(CLAUDE, '   ')).toBeNull();
  });

  it('passes a real backend reason straight through', () => {
    expect(stopReasonFor(CLAUDE, 'max_tokens')).toBe('max_tokens');
    expect(stopReasonFor(CODEX, ' length ')).toBe('length');
  });
});
