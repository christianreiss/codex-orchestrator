//go:build cxx_otel

package tracing

// The real pipeline. Everything in this file is behind the cxx_otel build tag:
// it is the only file in the package that imports go.opentelemetry.io, and the
// only reason the SDK ever reaches the linker. The default build uses
// tracing_stub.go instead. See the package comment in tracing.go for why.
//
// # The egress argument
//
// internal/codex.PreExec calls os.Setenv on OTEL_EXPORTER_OTLP_ENDPOINT,
// OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_SERVICE_NAME, OTEL_TRACES_EXPORTER,
// OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_HEADERS *inside this very
// process*, so that the child Codex CLI inherits the collector the user
// configured for Codex in ~/.codex/config.toml. Those headers routinely carry a
// bearer token.
//
// So the standard OTEL_* names are, in this process, someone else's
// configuration. If the wrapper's own tracing read them — directly, or by
// letting the SDK autoconfigure itself from the environment — every cdx run
// would quietly ship the wrapper's spans, and that Authorization header, to a
// collector the user never pointed at this wrapper. That is data egress, not a
// wiring bug. This package therefore:
//
//   - reads only CXX_OTEL_* names, through an injectable getenv so the rule is
//     testable rather than merely documented (see ConfigFromEnv in tracing.go);
//   - passes an explicit option for every exporter and provider field the SDK
//     would otherwise take from the environment; and
//   - builds the exporter and the provider inside withoutBareOTELEnv, which
//     removes the entire OTEL_ namespace from the process environment for the
//     duration and restores it exactly.
//
// The second point matters as much as the first. In otlptracehttp v1.44,
// otlpconfig.NewHTTPConfig applies ApplyHTTPEnvConfigs *before* caller options,
// so an explicit option wins — but only for a field that is actually set. The
// env-reachable fields are endpoint/URL path/insecure (ENDPOINT,
// TRACES_ENDPOINT, INSECURE, TRACES_INSECURE), TLS (CERTIFICATE,
// CLIENT_CERTIFICATE, CLIENT_KEY and their TRACES_ variants), HEADERS,
// COMPRESSION and TIMEOUT; newExporterOptions covers all of them. On the SDK
// side, sdktrace.NewTracerProvider reads OTEL_TRACES_SAMPLER via
// samplerFromEnv, sdktrace.NewSpanLimits reads the six OTEL_SPAN_*/OTEL_*_LIMIT
// variables, and sdktrace.NewBatchSpanProcessor reads OTEL_BSP_*; each is
// overridden explicitly below.
//
// Explicit options alone are not enough, which is why the third point exists.
// sdktrace.WithResource takes no option that suppresses its unconditional merge
// with resource.Environment(), so OTEL_RESOURCE_ATTRIBUTES would ride out on
// every span regardless of what this package passes. The scrub closes that, and
// covers OTEL_GO_X_* (the SDK's experimental self-observability toggles) for
// free.
//
// # No global provider
//
// Init deliberately does not call otel.SetTracerProvider. Nothing else in this
// binary opens spans, parent/child nesting travels through context.Context
// either way, and leaving the global unset means no dependency can start
// emitting through our exporter by accident.

import (
	"context"
	"crypto/tls"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
	"go.opentelemetry.io/otel/trace"
)

const (
	// shutdownBudget bounds the final flush. cdx is an interactive wrapper:
	// an unreachable collector must not hold up the user's shell.
	shutdownBudget = 2 * time.Second

	// scope names the instrumentation library on every span.
	scope = "github.com/christianreiss/codex-orchestrator/wrappers/cxx"
)

// Options configures one Init call. The default build's Options (in
// tracing_stub.go) carries the same fields minus Exporter, which is an
// SDK-typed test seam and therefore cannot exist there.
type Options struct {
	// Engine is "codex" or "claude"; it lands on the resource and on the
	// lifecycle spans.
	Engine string
	// Version is the wrapper version reported as service.version.
	Version string
	// Logger receives the debug lines this package emits. Tracing never warns
	// and never fails a run.
	Logger *slog.Logger
	// Env overrides the environment lookup. nil means os.Getenv.
	Env func(string) string
	// Exporter replaces the OTLP exporter. Tests pass an in-memory exporter so
	// the suite opens no socket; it is fed by a SimpleSpanProcessor so spans
	// are visible the moment they end. Setting it does NOT enable tracing —
	// EnvEnabled alone decides that.
	Exporter sdktrace.SpanExporter
}

type state struct {
	provider *sdktrace.TracerProvider
	tracer   trace.Tracer
	logger   *slog.Logger
}

var (
	initMu  sync.Mutex
	current atomic.Pointer[state]
)

// Init installs the tracing pipeline when CXX_OTEL_TRACES_ENABLED is truthy and
// returns the teardown to defer. The returned function is always safe to call,
// is idempotent, and never reports an error to the caller: a wrapper run must
// not fail because a collector is misconfigured.
func Init(ctx context.Context, opts Options) func() {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	cfg := ConfigFromEnv(opts.Env)
	if !cfg.Enabled {
		return noop
	}

	initMu.Lock()
	defer initMu.Unlock()
	if current.Load() != nil {
		// A second lifecycle in the same process reuses the first pipeline;
		// tearing it down here would end spans the first one still owns.
		return noop
	}

	// Installed before anything else touches the SDK. Construction itself can
	// raise — an unparseable OTEL_TRACES_SAMPLER makes samplerFromEnv call
	// otel.Handle — and the stock handler writes to stderr, straight over the
	// boot screen.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		logger.Debug("wrapper tracing error", "err", err)
	}))

	var (
		provider *sdktrace.TracerProvider
		buildErr error
	)
	withoutBareOTELEnv(func() {
		exporter := opts.Exporter
		var processor sdktrace.SpanProcessor
		if exporter == nil {
			exp, err := otlptracehttp.New(ctx, newExporterOptions(cfg)...)
			if err != nil {
				buildErr = err
				return
			}
			exporter = exp
			processor = sdktrace.NewBatchSpanProcessor(exporter, batchOptions(cfg)...)
		} else {
			processor = sdktrace.NewSimpleSpanProcessor(exporter)
		}

		provider = sdktrace.NewTracerProvider(
			// WithResource is not the whole story: it merges whatever it is
			// given with resource.Environment(), and the nil fallback is
			// resource.Default(), which is env-derived too. The scrub above is
			// what actually keeps OTEL_RESOURCE_ATTRIBUTES off our spans.
			sdktrace.WithResource(newResource(cfg, opts)),
			// Explicit sampler: NewTracerProvider otherwise takes one from
			// OTEL_TRACES_SAMPLER, and always_off would silently drop
			// everything.
			sdktrace.WithSampler(sdktrace.AlwaysSample()),
			// Explicit limits: sdktrace.NewSpanLimits reads six OTEL_ vars.
			sdktrace.WithRawSpanLimits(fixedSpanLimits()),
			sdktrace.WithSpanProcessor(processor),
		)
	})
	if buildErr != nil {
		logger.Debug("wrapper tracing disabled; OTLP exporter unavailable", "err", buildErr)
		return noop
	}

	current.Store(&state{
		provider: provider,
		tracer:   provider.Tracer(scope),
		logger:   logger,
	})

	return shutdown
}

func shutdown() {
	initMu.Lock()
	st := current.Swap(nil)
	initMu.Unlock()
	if st == nil {
		return
	}
	sctx, cancel := context.WithTimeout(context.Background(), shutdownBudget)
	defer cancel()
	if err := st.provider.Shutdown(sctx); err != nil {
		st.logger.Debug("wrapper tracing shutdown incomplete", "err", err)
	}
}

// bareOTELPrefix is the namespace that, inside this process, belongs to the
// child Codex CLI rather than to the wrapper.
const bareOTELPrefix = "OTEL_"

// withoutBareOTELEnv runs fn with every OTEL_* variable removed from the
// process environment, restoring them exactly afterwards.
//
// The explicit options in newExporterOptions, batchOptions and fixedSpanLimits
// are the contract, and the egress test verifies them end to end. This is the
// blanket underneath: an explicit option only neutralises a field somebody
// remembered to enumerate, and the SDK does read env in places that take no
// option at all — sdktrace.WithResource merges resource.Environment()
// unconditionally, so OTEL_RESOURCE_ATTRIBUTES would otherwise ride out on
// every span this wrapper emits. Scrubbing the whole prefix also means a future
// SDK version that starts reading a new OTEL_ name cannot quietly reintroduce
// the problem.
//
// Mutating the process environment is safe exactly here, and the argument is
// about the call graph rather than about the window being short:
//
//   - Init is the first statement of lifecycle.Run, so no goroutine this binary
//     starts is running yet — the agentbus/agentportal brokers and the legacy
//     sync fan-out all come later in the same Run.
//   - lifecycle.Run is reached at most once per process. Each persona's
//     internal/app main dispatches it from mutually exclusive switch arms, and
//     the dual-engine coordinator (internal/cron.runEnabledTicks) ticks each
//     persona as a separate child process, sequentially — never two Runs in one
//     process.
//   - codex.PreExec exports these same names much later in that same Run, on
//     the same goroutine, and sources them from ~/.codex/config.toml rather
//     than from what it finds in the environment. It cannot observe or be
//     clobbered by the scrub.
//   - agentportal.ScrubEnvironment swaps only the portal's own variables, so
//     the two env-swappers do not overlap.
//
// The scrub also runs under initMu, so a second Init cannot interleave with it.
// If lifecycle.Run ever becomes reachable twice in one process, or Init moves
// off the main goroutine, this reasoning has to be redone.
func withoutBareOTELEnv(fn func()) {
	type saved struct {
		key   string
		value string
	}
	var restore []saved
	for _, entry := range os.Environ() {
		eq := strings.Index(entry, "=")
		if eq <= 0 {
			continue
		}
		key := entry[:eq]
		if !strings.HasPrefix(key, bareOTELPrefix) {
			continue
		}
		restore = append(restore, saved{key: key, value: entry[eq+1:]})
	}
	defer func() {
		for _, s := range restore {
			_ = os.Setenv(s.key, s.value)
		}
	}()
	for _, s := range restore {
		_ = os.Unsetenv(s.key)
	}
	fn()
}

// newResource builds the resource by hand. resource.Default and resource.New
// with the default detectors both read OTEL_SERVICE_NAME and
// OTEL_RESOURCE_ATTRIBUTES, which in this process belong to the child Codex
// CLI. NewWithAttributes reads nothing.
func newResource(cfg Config, opts Options) *resource.Resource {
	attrs := []attribute.KeyValue{semconv.ServiceName(cfg.ServiceName)}
	if v := strings.TrimSpace(opts.Version); v != "" {
		attrs = append(attrs, semconv.ServiceVersion(v))
	}
	if e := strings.TrimSpace(opts.Engine); e != "" {
		attrs = append(attrs, attribute.String("wrapper.engine", e))
	}
	return resource.NewWithAttributes(semconv.SchemaURL, attrs...)
}

// newExporterOptions sets one explicit option per env-reachable exporter field.
// Dropping any of these hands that field back to the environment — which here
// means back to the Codex CLI's collector. See the file comment above.
func newExporterOptions(cfg Config) []otlptracehttp.Option {
	return []otlptracehttp.Option{
		// Endpoint host, URL path and the insecure flag, all three.
		otlptracehttp.WithEndpointURL(cfg.Endpoint),
		// Non-nil even when empty: this is what erases a header set through
		// OTEL_EXPORTER_OTLP_HEADERS, which PreExec populates with the user's
		// Codex collector credentials.
		otlptracehttp.WithHeaders(cfg.Headers),
		// nil clears any root CA or client certificate loaded from
		// OTEL_EXPORTER_OTLP_CERTIFICATE / _CLIENT_CERTIFICATE / _CLIENT_KEY.
		otlptracehttp.WithTLSClientConfig((*tls.Config)(nil)),
		otlptracehttp.WithCompression(otlptracehttp.NoCompression),
		otlptracehttp.WithTimeout(cfg.Timeout),
		// Retries are off: the default policy keeps trying for up to a minute,
		// which a user waiting on their shell prompt would pay for at exit.
		otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}),
	}
}

// batchOptions pins every field sdktrace.NewBatchSpanProcessor would otherwise
// read from OTEL_BSP_*. The batch timeout is short because a wrapper run is
// short — the queue is normally drained by the shutdown flush, not by the timer.
func batchOptions(cfg Config) []sdktrace.BatchSpanProcessorOption {
	return []sdktrace.BatchSpanProcessorOption{
		sdktrace.WithMaxQueueSize(sdktrace.DefaultMaxQueueSize),
		sdktrace.WithMaxExportBatchSize(sdktrace.DefaultMaxExportBatchSize),
		sdktrace.WithBatchTimeout(time.Second),
		sdktrace.WithExportTimeout(cfg.Timeout),
	}
}

func fixedSpanLimits() sdktrace.SpanLimits {
	return sdktrace.SpanLimits{
		AttributeValueLengthLimit:   sdktrace.DefaultAttributeValueLengthLimit,
		AttributeCountLimit:         sdktrace.DefaultAttributeCountLimit,
		EventCountLimit:             sdktrace.DefaultEventCountLimit,
		LinkCountLimit:              sdktrace.DefaultLinkCountLimit,
		AttributePerEventCountLimit: sdktrace.DefaultAttributePerEventCountLimit,
		AttributePerLinkCountLimit:  sdktrace.DefaultAttributePerLinkCountLimit,
	}
}

// Enabled reports whether spans are being recorded right now.
func Enabled() bool { return current.Load() != nil }

// kv converts the package's SDK-free Attr into the SDK's own type. This is the
// only place the two vocabularies meet.
func (a Attr) kv() attribute.KeyValue {
	switch a.kind {
	case kindInt:
		return attribute.Int(a.key, a.num)
	case kindBool:
		return attribute.Bool(a.key, a.flag)
	default:
		return attribute.String(a.key, a.str)
	}
}

type liveSpan struct{ span trace.Span }

func (s liveSpan) SetString(key, value string) { s.span.SetAttributes(attribute.String(key, value)) }
func (s liveSpan) SetInt(key string, value int) {
	s.span.SetAttributes(attribute.Int(key, value))
}
func (s liveSpan) SetBool(key string, value bool) { s.span.SetAttributes(attribute.Bool(key, value)) }
func (s liveSpan) End()                           { s.span.End() }

func (s liveSpan) Fail(err error) {
	if err == nil {
		return
	}
	t := ErrorType(err)
	s.span.SetAttributes(attribute.String("error.type", t))
	s.span.SetStatus(codes.Error, t)
}

// Start opens a span named name. When tracing is off it returns ctx unchanged
// and a no-op span, so a call site behaves identically either way.
func Start(ctx context.Context, name string, attrs ...Attr) (context.Context, Span) {
	st := current.Load()
	if st == nil {
		return ctx, disabled
	}
	kvs := make([]attribute.KeyValue, 0, len(attrs))
	for _, a := range attrs {
		kvs = append(kvs, a.kv())
	}
	spanCtx, span := st.tracer.Start(ctx, name, trace.WithAttributes(kvs...))
	return spanCtx, liveSpan{span: span}
}
