//go:build !cxx_otel

package tracing

// The default build. This file is what makes "off by default" a *link-time*
// property rather than only a runtime one: it imports nothing from
// go.opentelemetry.io, so the SDK, the OTLP exporter, gRPC, protobuf and
// genproto never reach the linker. Building with `-tags cxx_otel` swaps in
// tracing_otel.go instead. See the package comment in tracing.go.
//
// Every exported name here matches the traced build, so no call site branches,
// and neither persona lifecycle knows which half it was compiled against.

import (
	"context"
	"log/slog"
)

// Options configures one Init call. It mirrors the traced build's Options minus
// Exporter, which is typed against sdktrace.SpanExporter and so cannot exist in
// a file that must not import the SDK. Nothing outside the package's own
// (tagged) tests sets it.
type Options struct {
	// Engine is "codex" or "claude". Recorded only in the traced build.
	Engine string
	// Version is the wrapper version. Recorded only in the traced build.
	Version string
	// Logger receives the one debug line this file can emit.
	Logger *slog.Logger
	// Env overrides the environment lookup. nil means os.Getenv.
	Env func(string) string
}

// Init is inert. It still resolves the flag, for one reason: a user who sets
// CXX_OTEL_TRACES_ENABLED on a fleet-distributed binary would otherwise get
// silence with no way to tell why. The released artifact is built untagged, so
// it genuinely cannot trace; this leaves a breadcrumb at debug level instead of
// nothing. No exporter, no provider, no goroutine, no socket.
func Init(_ context.Context, opts Options) func() {
	if ConfigFromEnv(opts.Env).Enabled {
		logger := opts.Logger
		if logger == nil {
			logger = slog.Default()
		}
		logger.Debug("wrapper tracing requested but not compiled in; rebuild with -tags cxx_otel",
			"flag", EnvEnabled)
	}
	return noop
}

// Enabled is always false in this build.
func Enabled() bool { return false }

// Start returns the caller's context unchanged and a zero-sized no-op span, so
// a call site behaves exactly as it does in the traced build with tracing off.
func Start(ctx context.Context, _ string, _ ...Attr) (context.Context, Span) {
	return ctx, disabled
}
