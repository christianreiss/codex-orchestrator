//go:build !cxx_otel

package tracing

// The default build's own tests. They assert the stub is inert *even when the
// operator asks for tracing* — which is exactly the situation a released,
// untagged binary is in when someone exports CXX_OTEL_TRACES_ENABLED.

import (
	"context"
	"errors"
	"testing"
)

// TestStubStaysInertWithTheSwitchOn is the difference between the two builds.
// In the traced build this same environment starts a pipeline; here it must
// change nothing at all.
func TestStubStaysInertWithTheSwitchOn(t *testing.T) {
	clearAmbientOTEL(t)
	t.Setenv(EnvEnabled, "1")
	t.Setenv(EnvEndpoint, "http://127.0.0.1:1/v1/traces")

	// The flag still resolves — that is what lets Init leave a debug
	// breadcrumb — but it must not switch anything on.
	if !ConfigFromEnv(nil).Enabled {
		t.Fatal("the resolver stopped reading the flag; the stub cannot warn without it")
	}

	stop := Init(context.Background(), Options{Engine: "codex", Logger: quietLogger()})
	t.Cleanup(stop)
	if Enabled() {
		t.Fatal("the default build reported tracing enabled; the SDK is not linked, so it cannot be")
	}

	ctx := context.Background()
	got, span := Start(ctx, "cxx.lifecycle.run", String("wrapper.engine", "codex"), Int("n", 1), Bool("b", true))
	if got != ctx {
		t.Fatal("the stub's Start must return the caller's context unchanged")
	}
	if span != disabled {
		t.Fatal("the stub's Start must return the shared zero-sized no-op span")
	}
	span.SetString("wrapper.engine", "codex")
	span.SetInt("wrapper.exit_code", 2)
	span.SetBool("wrapper.concurrent", false)
	span.Fail(errors.New("boom"))
	span.End()
}

// TestStubTeardownIsAlwaysTheSameNoOp guards the one thing a caller can hold on
// to across a whole run.
func TestStubTeardownIsAlwaysTheSameNoOp(t *testing.T) {
	clearAmbientOTEL(t)
	t.Setenv(EnvEnabled, "1")
	first := Init(context.Background(), Options{Engine: "claude", Logger: quietLogger()})
	second := Init(context.Background(), Options{Engine: "claude", Logger: quietLogger()})
	first()
	second()
	first()
	if Enabled() {
		t.Fatal("repeated Init/teardown left the stub reporting enabled")
	}
}

// TestStubInitDoesNotRequireALogger pins the nil-Logger path, which the debug
// breadcrumb walks through.
func TestStubInitDoesNotRequireALogger(t *testing.T) {
	clearAmbientOTEL(t)
	t.Setenv(EnvEnabled, "true")
	stop := Init(context.Background(), Options{Engine: "codex"})
	stop()
}
