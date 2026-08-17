import { ApiError } from '../http/errors.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';

/**
 * What each transport can actually do with a generation control.
 *
 * The compat gateways accepted `temperature`, `top_p`, `top_k` and
 * `stop_sequences`, forwarded them to the runner, and the runner passed them to
 * neither CLI. `docs/auth-runner.md` even said so — "accepted for wire-format
 * compatibility and reach neither CLI" — which documents the behaviour without
 * making it defensible. A caller that sets `temperature: 0` to make a
 * classification deterministic gets a sampled answer and no indication that its
 * instruction was dropped.
 *
 * There is exactly one transport today: `runner-cli`, which shells out to
 * `codex exec` / `claude` through the runner's `/exec`. A CLI takes a prompt, a
 * model and images. It has no flags for the sampling controls, so this table
 * says so and the gateways refuse the request instead of pretending.
 *
 * When a real provider-API transport lands (the OpenAI/Anthropic SDK adapters),
 * it gets its own entry here with `enforced` for the controls it genuinely
 * honors, and the same predicate keeps both surfaces truthful.
 */

export type TransportId = 'runner-cli';

export type ControlSupport =
  /** Passed through and honored by the backend. */
  | 'enforced'
  /** The backend cannot honor it. Supplying it is a request the gateway refuses. */
  | 'unsupported'
  /**
   * The upstream protocol makes the field mandatory, so refusing it would break
   * every conforming client, but this transport cannot enforce it. Accepted,
   * never claimed as honored, and reported as a capability limit.
   */
  | 'accepted-unenforceable';

export type GenerationControl =
  | 'model'
  | 'max_tokens'
  | 'temperature'
  | 'top_p'
  | 'top_k'
  | 'stop_sequences'
  | 'system'
  | 'stream'
  | 'tools';

export interface TransportCapabilities {
  transport: TransportId;
  engine: Engine;
  controls: Record<GenerationControl, ControlSupport>;
  /** Token counts the backend reports rather than the gateway inventing. */
  reportsExactUsage: boolean;
  /** Whether the backend tells us *why* generation stopped. */
  reportsStopReason: boolean;
}

/**
 * `max_tokens` is `accepted-unenforceable` rather than `unsupported` because
 * Anthropic's Messages API requires it on every request: rejecting it would
 * make the compat surface unusable with the official SDK, which is a worse
 * outcome than an honestly-labelled limitation. Nothing downstream may report a
 * `max_tokens` stop reason on this transport as a result — see
 * `stopReasonFor()`.
 *
 * `system` is enforced only for Claude: the runner writes it into the Claude
 * invocation, and `codex exec` has nowhere to put it.
 */
const RUNNER_CLI_CONTROLS: Record<Engine, Record<GenerationControl, ControlSupport>> = {
  [ENGINE_CODEX]: {
    model: 'enforced',
    max_tokens: 'accepted-unenforceable',
    temperature: 'unsupported',
    top_p: 'unsupported',
    top_k: 'unsupported',
    stop_sequences: 'unsupported',
    system: 'unsupported',
    stream: 'unsupported',
    tools: 'unsupported',
  },
  [ENGINE_CLAUDE]: {
    model: 'enforced',
    max_tokens: 'accepted-unenforceable',
    temperature: 'unsupported',
    top_p: 'unsupported',
    top_k: 'unsupported',
    stop_sequences: 'unsupported',
    system: 'enforced',
    stream: 'unsupported',
    tools: 'unsupported',
  },
};

export function capabilitiesFor(
  transport: TransportId,
  engine: Engine,
): TransportCapabilities {
  return {
    transport,
    engine,
    controls: RUNNER_CLI_CONTROLS[engine],
    // The CLI reports token counts only on the Claude path, and neither CLI
    // says why it stopped.
    reportsExactUsage: engine === ENGINE_CLAUDE,
    reportsStopReason: false,
  };
}

export class UnsupportedControlError extends ApiError {
  constructor(controls: readonly GenerationControl[], capabilities: TransportCapabilities) {
    const list = [...controls].sort();
    super(
      `This deployment executes ${capabilities.engine} through its CLI, which cannot honor ` +
        `${list.join(', ')}. Remove ${list.length === 1 ? 'it' : 'them'} from the request, or ` +
        `configure a provider API credential whose transport supports ${list.length === 1 ? 'it' : 'them'}.`,
      {
        status: 400,
        code: 'unsupported_generation_control',
        type: 'invalid_request_error',
        extra: {
          unsupported: list,
          transport: capabilities.transport,
          engine: capabilities.engine,
        },
      },
    );
  }
}

/**
 * Refuse a request that supplies a control this transport cannot honor.
 *
 * Deliberately before execution: a control the backend will ignore must not
 * reach it, because the caller cannot tell the difference between "honored" and
 * "silently dropped" from the response. `400` and not `422`, and non-retriable —
 * repeating the same request will fail identically until the request or the
 * credential changes.
 */
export function assertControlsSupported(
  supplied: Partial<Record<GenerationControl, unknown>>,
  capabilities: TransportCapabilities,
): void {
  const unsupported = (Object.keys(supplied) as GenerationControl[]).filter((control) => {
    const value = supplied[control];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return capabilities.controls[control] === 'unsupported';
  });
  if (unsupported.length > 0) throw new UnsupportedControlError(unsupported, capabilities);
}

/**
 * The stop reason to report, given what the backend actually told us.
 *
 * Every OpenAI result was hardcoded `finish_reason: "stop"` and every Claude
 * result `stop_reason: "end_turn"`, which asserts "the model finished its turn"
 * for output that may have been cut off by a CLI timeout or a crash. A
 * transport that does not report a stop reason gets the protocol's own
 * "unknown" spelling instead of a confident lie.
 */
export function stopReasonFor(
  _capabilities: TransportCapabilities,
  backendReason: string | null | undefined,
): string | null {
  if (typeof backendReason === 'string' && backendReason.trim() !== '') {
    return backendReason.trim();
  }
  // `null` is what both protocols use for "no claim about why this stopped":
  // OpenAI's `finish_reason` and Anthropic's `stop_reason` are both nullable.
  // That is the truth for a CLI transport, and it is what an SDK will surface
  // to the caller rather than a confident `"stop"`.
  return null;
}
