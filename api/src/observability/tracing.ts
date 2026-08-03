import type { Span, Tracer } from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace-node';

/**
 * Optional OpenTelemetry tracing.
 *
 * Off unless `OTEL_TRACES_ENABLED` is set. "Off" here means genuinely nothing:
 * `initTracing` returns before it imports anything, so no OpenTelemetry package
 * is loaded, no provider is registered, no exporter exists and no socket is
 * opened. `withSpan` then calls straight through to its callback — the disabled
 * path costs one null check and allocates nothing.
 *
 * Instrumentation is manual on purpose. `scripts/build.ts` bundles and minifies
 * the server, so the auto-instrumentation packages have nothing recognisable to
 * monkey-patch; spans are opened explicitly at the few places worth measuring.
 *
 * Exporter destination, headers, timeouts and sampling come from the
 * spec-standard `OTEL_EXPORTER_OTLP_*` / `OTEL_TRACES_SAMPLER*` variables, which
 * the SDK reads itself. Only the on/off switch and the service name are part of
 * this repo's `env.ts`.
 *
 * Never put a secret on a span. Attributes carry host id, engine, config
 * version and counts — never an API key, a signature value, a key fingerprint
 * or the canonical payload bytes. Spans leave the process for a collector this
 * code does not control, so they are a lower-trust sink than a log line.
 */

/** Attribute values a span accepts. Deliberately narrower than OTel's own. */
export type TraceAttributeValue = string | number | boolean;

export type TraceAttributes = Record<string, TraceAttributeValue | undefined>;

/**
 * The slice of a span callers may touch. Keeping this local means call sites
 * compile — and run — identically whether or not the SDK was ever loaded.
 */
export interface TraceSpan {
  /** Records an attribute. `undefined` is dropped rather than stringified. */
  setAttribute(key: string, value: TraceAttributeValue | undefined): void;
}

const NOOP_SPAN: TraceSpan = {
  setAttribute() {
    /* tracing disabled */
  },
};

/** The env fields tracing reads. `Env` from `env.ts` satisfies this. */
export interface TracingEnv {
  OTEL_TRACES_ENABLED: boolean;
  OTEL_SERVICE_NAME: string;
}

export interface TracingOverrides {
  /**
   * Replaces the OTLP exporter. Tests pass an in-memory exporter so the suite
   * never opens a socket. An injected exporter is fed by a `SimpleSpanProcessor`
   * so its owner sees each span the moment it ends; the default OTLP exporter
   * is batched.
   *
   * This does NOT enable tracing: `OTEL_TRACES_ENABLED` alone decides that.
   */
  exporter?: SpanExporter;
}

interface TracingState {
  api: typeof import('@opentelemetry/api');
  provider: import('@opentelemetry/sdk-trace-node').NodeTracerProvider;
  tracer: Tracer;
}

const INSTRUMENTATION_SCOPE = 'codex-orchestrator/api';

let state: TracingState | null = null;

/**
 * Loads and registers the tracing SDK when `OTEL_TRACES_ENABLED` is on.
 * Idempotent, and a no-op — including the dynamic imports — when it is off.
 */
export async function initTracing(
  env: TracingEnv,
  overrides: TracingOverrides = {},
): Promise<void> {
  // The flag is the only gate. An exporter override must never be able to turn
  // tracing on by itself, otherwise "disabled" is untestable.
  if (!env.OTEL_TRACES_ENABLED) return;
  if (state) return;

  const api = await import('@opentelemetry/api');
  const { NodeTracerProvider, BatchSpanProcessor, SimpleSpanProcessor } = await import(
    '@opentelemetry/sdk-trace-node'
  );
  const { defaultResource, resourceFromAttributes } = await import('@opentelemetry/resources');

  const processor = overrides.exporter
    ? new SimpleSpanProcessor(overrides.exporter)
    : new BatchSpanProcessor(
        new (await import('@opentelemetry/exporter-trace-otlp-http')).OTLPTraceExporter(),
      );

  const provider = new NodeTracerProvider({
    // `defaultResource()` carries the SDK's own env-detected attributes; ours
    // wins on collision so the service name is never `unknown_service`.
    resource: defaultResource().merge(
      resourceFromAttributes({ 'service.name': env.OTEL_SERVICE_NAME }),
    ),
    spanProcessors: [processor],
  });
  // Registering globally installs the AsyncLocalStorage context manager, which
  // is what lets a bake span nest under its route span without threading a
  // parent through `bakeForHost`'s signature.
  provider.register();

  state = { api, provider, tracer: provider.getTracer(INSTRUMENTATION_SCOPE) };
}

/** Whether spans are being recorded right now. */
export function tracingEnabled(): boolean {
  return state !== null;
}

/**
 * Flushes and tears down the provider, and unregisters the API globals so a
 * later `initTracing` in the same process starts clean.
 */
export async function shutdownTracing(): Promise<void> {
  const current = state;
  state = null;
  if (!current) return;
  current.api.trace.disable();
  current.api.context.disable();
  current.api.propagation.disable();
  await current.provider.shutdown();
}

/**
 * Runs `fn` inside a span named `name`, or runs it directly when tracing is off.
 *
 * The span is ended on every exit. A throw sets status ERROR and records the
 * error's class name — never its message, which can echo caller-supplied text —
 * then rethrows unchanged, so control flow is identical with tracing on or off.
 */
export function withSpan<T>(
  name: string,
  attributes: TraceAttributes,
  fn: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  const current = state;
  if (!current) return fn(NOOP_SPAN);
  const { api, tracer } = current;
  return tracer.startActiveSpan(name, { attributes }, async (span: Span): Promise<T> => {
    try {
      return await fn(handleFor(span));
    } catch (err) {
      const type = errorType(err);
      span.setAttribute('error.type', type);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: type });
      throw err;
    } finally {
      span.end();
    }
  });
}

function handleFor(span: Span): TraceSpan {
  return {
    setAttribute(key, value) {
      if (value === undefined) return;
      span.setAttribute(key, value);
    },
  };
}

function errorType(err: unknown): string {
  if (err instanceof Error && typeof err.name === 'string' && err.name !== '') return err.name;
  return 'Error';
}
