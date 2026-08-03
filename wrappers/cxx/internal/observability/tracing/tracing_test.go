package tracing

// Tests that hold in BOTH build modes. `go test ./...` runs them against the
// stub; `go test -tags cxx_otel ./...` runs them against the real SDK, and they
// have to pass identically either way — that equivalence is the whole point of
// the split. Mode-specific tests live in tracing_otel_test.go and
// tracing_stub_test.go.

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// clearAmbientOTEL removes any bare OTEL_* variable the developer's own shell
// (or a sibling test) may have exported, so a test that deliberately sets one
// is the only source of it. It unsets rather than blanking: an empty
// OTEL_TRACES_SAMPLER is a *present* variable and makes the SDK raise
// "unsupported sampler".
func clearAmbientOTEL(t *testing.T) {
	t.Helper()
	// Anchors t to the no-parallel discipline t.Setenv enforces, since the
	// manual save/restore below cannot.
	t.Setenv("CXX_OTEL_TEST", "1")
	for _, entry := range os.Environ() {
		eq := strings.Index(entry, "=")
		if eq <= 0 || !strings.HasPrefix(entry[:eq], "OTEL_") {
			continue
		}
		key, value := entry[:eq], entry[eq+1:]
		t.Cleanup(func() { _ = os.Setenv(key, value) })
		if err := os.Unsetenv(key); err != nil {
			t.Fatalf("unset %s: %v", key, err)
		}
	}
}

// --- the gate -------------------------------------------------------------

// TestDisabledWithoutTheSwitch is the contract both halves owe the call sites:
// without CXX_OTEL_TRACES_ENABLED, Start hands back the caller's own context
// and a span whose every method is safe. In the default build this is also the
// only path that exists.
func TestDisabledWithoutTheSwitch(t *testing.T) {
	clearAmbientOTEL(t)
	stop := Init(context.Background(), Options{Engine: "codex", Logger: quietLogger()})
	t.Cleanup(stop)

	if Enabled() {
		t.Fatal("tracing enabled with CXX_OTEL_TRACES_ENABLED unset")
	}
	ctx := context.Background()
	got, span := Start(ctx, "cxx.lifecycle.run")
	if got != ctx {
		t.Fatal("disabled Start must return the caller's context unchanged")
	}
	// Every method has to be safe on the no-op span; call sites do not branch.
	span.SetString("wrapper.engine", "codex")
	span.SetInt("wrapper.exit_code", 0)
	span.SetBool("wrapper.concurrent", true)
	span.Fail(errors.New("boom"))
	span.End()
	// Teardown is idempotent in both builds.
	stop()
	stop()
}

// TestConfigFromEnvReadsOnlyCXXNames pins the rule at the resolver: every
// lookup this package makes has to be a CXX_-prefixed name. The resolver is in
// the untagged file precisely so this guard also covers the default build.
func TestConfigFromEnvReadsOnlyCXXNames(t *testing.T) {
	var seen []string
	cfg := ConfigFromEnv(func(key string) string {
		seen = append(seen, key)
		switch key {
		case EnvEnabled:
			return "yes"
		case EnvHeaders:
			return "X-Tenant=acme,X-Escaped=a%20b, ,broken"
		case EnvTimeout:
			return "250"
		default:
			return ""
		}
	})
	if len(seen) == 0 {
		t.Fatal("resolver read no variables at all")
	}
	for _, key := range seen {
		if !strings.HasPrefix(key, "CXX_OTEL_") {
			t.Fatalf("resolver read %q; only CXX_OTEL_* names are allowed", key)
		}
	}
	if !cfg.Enabled {
		t.Fatal("\"yes\" should enable tracing")
	}
	if cfg.Endpoint != defaultEndpoint || cfg.ServiceName != defaultServiceName {
		t.Fatalf("defaults not applied: %+v", cfg)
	}
	if cfg.Timeout != 250*time.Millisecond {
		t.Fatalf("timeout = %s, want 250ms", cfg.Timeout)
	}
	if cfg.Headers["X-Tenant"] != "acme" || cfg.Headers["X-Escaped"] != "a b" {
		t.Fatalf("header parse wrong: %+v", cfg.Headers)
	}
	if _, ok := cfg.Headers["broken"]; ok {
		t.Fatalf("a value-less entry became a header: %+v", cfg.Headers)
	}
}

func TestHeadersAreAlwaysNonNil(t *testing.T) {
	// A nil map would leave OTEL_EXPORTER_OTLP_HEADERS in place, because
	// otlptracehttp.WithHeaders assigns whatever it is given. The traced build
	// checks the option list itself; see
	// TestExporterOptionsCoverEveryEnvReachableField.
	cfg := ConfigFromEnv(func(string) string { return "" })
	if cfg.Headers == nil {
		t.Fatal("resolved headers must be a non-nil empty map")
	}
}

// --- span hygiene ---------------------------------------------------------

type tokenError struct{}

func (tokenError) Error() string { return "Bearer sk-live-do-not-log" }

// TestErrorTypeNamesTheTypeNotTheMessage guards the single function that
// decides what a failure puts on a span. Span.Fail has no other source.
func TestErrorTypeNamesTheTypeNotTheMessage(t *testing.T) {
	if got := ErrorType(nil); got != "" {
		t.Fatalf("ErrorType(nil) = %q, want empty", got)
	}
	got := ErrorType(tokenError{})
	if got != "tracing.tokenError" {
		t.Fatalf("ErrorType = %q, want tracing.tokenError", got)
	}
	if strings.Contains(got, "sk-live-do-not-log") {
		t.Fatal("ErrorType leaked the error message")
	}
	if got := ErrorType(&tokenError{}); got != "tracing.tokenError" {
		t.Fatalf("ErrorType on a pointer = %q, want the dereferenced name", got)
	}
}

// TestAttrConstructorsKeepKeyAndValue is the SDK-free half of the attribute
// vocabulary: the union carries what it was handed, in both builds.
func TestAttrConstructorsKeepKeyAndValue(t *testing.T) {
	if a := String("wrapper.engine", "codex"); a.key != "wrapper.engine" || a.kind != kindString || a.str != "codex" {
		t.Fatalf("String built %+v", a)
	}
	if a := Int("wrapper.exit_code", 7); a.key != "wrapper.exit_code" || a.kind != kindInt || a.num != 7 {
		t.Fatalf("Int built %+v", a)
	}
	if a := Bool("wrapper.headless", true); a.key != "wrapper.headless" || a.kind != kindBool || !a.flag {
		t.Fatalf("Bool built %+v", a)
	}
}
