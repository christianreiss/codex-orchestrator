//go:build !cxx_otel

package lifecycle

// The default build's counterpart to tracing_test.go. There is no pipeline to
// assert on here, so what is worth pinning is that the call sites this package
// is littered with stay inert *while the operator is asking for tracing* —
// which is the state a released, untagged cxx is in whenever someone exports
// CXX_OTEL_TRACES_ENABLED and expects spans.

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/observability/tracing"
)

func TestTracingCallSitesStayInertInTheDefaultBuild(t *testing.T) {
	t.Setenv("CXX_OTEL_TRACES_ENABLED", "1")
	t.Setenv("CXX_OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1/v1/traces")

	stop := tracing.Init(context.Background(), tracing.Options{
		Engine: "codex",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	t.Cleanup(stop)
	if tracing.Enabled() {
		t.Fatal("tracing reported enabled in a build that does not link the SDK")
	}

	ctx := context.Background()
	got, span := tracing.Start(ctx, "cxx.lifecycle.run",
		tracing.String("wrapper.engine", "codex"),
		tracing.Bool("wrapper.headless", true),
	)
	if got != ctx {
		t.Fatal("a lifecycle span altered the context in the default build")
	}
	span.SetInt("wrapper.exit_code", 0)
	span.Fail(nil)
	span.End()
}
