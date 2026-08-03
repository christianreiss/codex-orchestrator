// Package tracing gives the cxx wrapper its own optional OpenTelemetry spans.
//
// # Compiled out by default
//
// The SDK is a *build-time* opt-in, not only a runtime one. This file holds the
// parts that never touch OpenTelemetry; the pipeline itself exists twice:
//
//   - tracing_stub.go (//go:build !cxx_otel) — the default. Every exported
//     entry point is inert, nothing from go.opentelemetry.io is imported, and
//     the linker never sees the SDK.
//   - tracing_otel.go (//go:build cxx_otel) — the real exporter and provider.
//
// The exported API is identical in both, so no call site branches or changes.
//
// The split exists because cxx is sha256-manifested and self-distributes to
// every host in the fleet. Linking the SDK unconditionally added ~7.2 MB (+79%)
// to a binary that every host re-downloads on each wrapper self-update, for a
// feature that is off by default. `make release` and the release CI job build
// untagged, so **the released artifact cannot trace at all**: setting
// CXX_OTEL_TRACES_ENABLED on it does nothing (the stub logs one debug line
// saying so). To get spans, build your own:
//
//	cd wrappers/cxx && go build -tags cxx_otel ./cmd/cxx
//	# or, from wrappers/: make cxx-traced
//
// # Off by default at runtime too
//
// Even in a traced build nothing happens unless CXX_OTEL_TRACES_ENABLED is
// truthy. With the flag unset Init returns before it builds an exporter or a
// provider: no socket is opened, no background goroutine starts, and Start
// returns the caller's context plus a zero-sized no-op span. The disabled path
// costs one atomic load.
//
// # Why every variable is CXX_-prefixed
//
// internal/codex.PreExec calls os.Setenv on OTEL_EXPORTER_OTLP_ENDPOINT,
// OTEL_EXPORTER_OTLP_HEADERS and friends *inside this very process*, so the
// child Codex CLI inherits the collector the user configured for Codex. Those
// headers routinely carry a bearer token. The standard OTEL_* names therefore
// belong to somebody else here, and this package must never read one. Only
// CXX_OTEL_* names are consulted, through an injectable getenv so the rule is
// testable rather than merely documented. tracing_otel.go carries the rest of
// the argument and the two further defences that go with it.
//
// # Never put a secret on a span
//
// Spans leave the process for a collector this repository does not control, so
// they are a lower-trust sink than a log line. Attributes carry statuses,
// counts, booleans and the engine name. Credentials, auth payloads, auth
// digests, API keys and error *messages* stay out; Fail records only an error's
// Go type name.
//
// # Known limitation: the two halves do not join
//
// No W3C trace context crosses the wrapper -> API boundary. The wrapper's spans
// and the API's bakery spans are two disconnected traces correlated only by
// timestamp and host id. Injecting `traceparent` would have to touch four
// separate HTTP clients here plus the API's deliberately lazy import boundary,
// so it is deliberately not done. See docs/wrapper-v2-architecture.md.
package tracing

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// The wrapper's own tracing variables. The CXX_ prefix is load-bearing: see the
// package comment. Nothing in this package may read a bare OTEL_* name.
const (
	// EnvEnabled is the only switch. An injected exporter cannot substitute
	// for it, so "disabled" stays testable.
	EnvEnabled = "CXX_OTEL_TRACES_ENABLED"
	// EnvEndpoint is the full OTLP/HTTP traces URL, path included.
	EnvEndpoint = "CXX_OTEL_EXPORTER_OTLP_ENDPOINT"
	// EnvHeaders is a W3C-Baggage-style "k=v,k2=v2" list; values are
	// percent-decoded, per the OTLP exporter specification.
	EnvHeaders = "CXX_OTEL_EXPORTER_OTLP_HEADERS"
	// EnvTimeout bounds one export attempt, in milliseconds.
	EnvTimeout = "CXX_OTEL_EXPORTER_OTLP_TIMEOUT"
	// EnvServiceName overrides the service.name resource attribute.
	EnvServiceName = "CXX_OTEL_SERVICE_NAME"
)

const (
	defaultEndpoint    = "http://localhost:4318/v1/traces"
	defaultServiceName = "cxx"
	defaultTimeout     = 5 * time.Second
)

// Config is the fully resolved tracing configuration. Every field comes from a
// CXX_OTEL_* variable or from a constant above — never from the environment the
// SDK would consult on its own.
type Config struct {
	Enabled     bool
	Endpoint    string
	Headers     map[string]string
	Timeout     time.Duration
	ServiceName string
}

// ConfigFromEnv resolves the wrapper's tracing configuration. getenv is
// injected rather than hardcoded to os.Getenv so a test can hand in a lookup
// that fails loudly on any bare OTEL_* name.
//
// It lives in the untagged file on purpose: the stub build still resolves the
// flag, so it can tell a user who set CXX_OTEL_TRACES_ENABLED that this binary
// was not built with tracing compiled in.
func ConfigFromEnv(getenv func(string) string) Config {
	if getenv == nil {
		getenv = os.Getenv
	}
	cfg := Config{
		Enabled:     truthy(getenv(EnvEnabled)),
		Endpoint:    strings.TrimSpace(getenv(EnvEndpoint)),
		Headers:     parseHeaders(getenv(EnvHeaders)),
		Timeout:     defaultTimeout,
		ServiceName: strings.TrimSpace(getenv(EnvServiceName)),
	}
	if cfg.Endpoint == "" {
		cfg.Endpoint = defaultEndpoint
	}
	if cfg.ServiceName == "" {
		cfg.ServiceName = defaultServiceName
	}
	if ms, err := strconv.Atoi(strings.TrimSpace(getenv(EnvTimeout))); err == nil && ms > 0 {
		cfg.Timeout = time.Duration(ms) * time.Millisecond
	}
	return cfg
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// parseHeaders decodes the "k=v,k2=v2" header list. The result is always
// non-nil: newExporterOptions hands it to otlptracehttp.WithHeaders, which
// assigns unconditionally, and an empty map is what erases any header the SDK
// picked up from OTEL_EXPORTER_OTLP_HEADERS.
func parseHeaders(raw string) map[string]string {
	out := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		eq := strings.Index(pair, "=")
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(pair[:eq])
		value := strings.TrimSpace(pair[eq+1:])
		if decoded, err := url.QueryUnescape(value); err == nil {
			value = decoded
		}
		if key == "" {
			continue
		}
		out[key] = value
	}
	return out
}

// noop is returned by every Init that has nothing to tear down — which, in the
// default build, is every Init.
func noop() {}

// attrKind tags Attr's union. Attr deliberately does not hold an
// attribute.KeyValue: that type comes from the SDK, and this file has to
// compile without it.
type attrKind uint8

const (
	kindString attrKind = iota
	kindInt
	kindBool
)

// Attr is the narrow slice of OpenTelemetry's attribute vocabulary the call
// sites use. Keeping it local means a lifecycle file imports this package and
// nothing else from the SDK — and that the same call site compiles in both
// build modes.
type Attr struct {
	key  string
	kind attrKind
	str  string
	num  int
	flag bool
}

// String, Int and Bool build the three attribute kinds worth recording. There
// is deliberately no constructor that takes a []byte, an error or an arbitrary
// any: those are how a credential or an error message ends up on a span.
func String(key, value string) Attr { return Attr{key: key, kind: kindString, str: value} }

// Int records a count.
func Int(key string, value int) Attr { return Attr{key: key, kind: kindInt, num: value} }

// Bool records a flag.
func Bool(key string, value bool) Attr { return Attr{key: key, kind: kindBool, flag: value} }

// Span is the part of a span the call sites may touch.
type Span interface {
	SetString(key, value string)
	SetInt(key string, value int)
	SetBool(key string, value bool)
	// Fail marks the span failed, recording the error's Go type name in
	// error.type. The message is never recorded: it routinely quotes server
	// responses, file paths and credentials-adjacent text.
	Fail(err error)
	End()
}

type noopSpan struct{}

func (noopSpan) SetString(string, string) {}
func (noopSpan) SetInt(string, int)       {}
func (noopSpan) SetBool(string, bool)     {}
func (noopSpan) Fail(error)               {}
func (noopSpan) End()                     {}

// disabled is a zero-sized value, so returning it from Start allocates nothing.
var disabled Span = noopSpan{}

// ErrorType names an error by its Go type. Exported so the span-hygiene test
// can assert that this — and never err.Error() — is what reaches a span.
func ErrorType(err error) string {
	if err == nil {
		return ""
	}
	return strings.TrimPrefix(fmt.Sprintf("%T", err), "*")
}
