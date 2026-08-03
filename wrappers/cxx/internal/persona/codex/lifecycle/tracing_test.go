//go:build cxx_otel

package lifecycle

// These tests drive the real OpenTelemetry pipeline, so they only build under
// -tags cxx_otel. The default build has no SDK to drive; its inert counterpart
// is tracing_default_test.go.

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/observability/tracing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// startTestTracing turns tracing on with an in-memory exporter, so no socket is
// opened. Because Init is idempotent, a lifecycle that calls it again during
// the test reuses this pipeline — which is how a Run span reaches the exporter.
func startTestTracing(t *testing.T) *tracetest.InMemoryExporter {
	t.Helper()
	t.Setenv("CXX_OTEL_TRACES_ENABLED", "1")
	exporter := tracetest.NewInMemoryExporter()
	stop := tracing.Init(context.Background(), tracing.Options{
		Engine:   "codex",
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Exporter: exporter,
	})
	t.Cleanup(stop)
	if !tracing.Enabled() {
		t.Fatal("test tracing pipeline did not start")
	}
	return exporter
}

func spanNamed(t *testing.T, exporter *tracetest.InMemoryExporter, name string) tracetest.SpanStub {
	t.Helper()
	var names []string
	for _, s := range exporter.GetSpans() {
		if s.Name == name {
			return s
		}
		names = append(names, s.Name)
	}
	t.Fatalf("span %q not emitted; got %v", name, names)
	return tracetest.SpanStub{}
}

func spanAttr(s tracetest.SpanStub, key string) string {
	for _, kv := range s.Attributes {
		if string(kv.Key) == key {
			return kv.Value.Emit()
		}
	}
	return ""
}

// TestRunEmitsRootSpanCarryingTheExitCode pins the root span onto a path Run
// really takes. The FQDN guard refuses before any network call, so the span
// closes with the refusal's exit code and error type and nothing else.
func TestRunEmitsRootSpanCarryingTheExitCode(t *testing.T) {
	exporter := startTestTracing(t)
	t.Setenv("CODEX_ALLOW_FQDN_MISMATCH", "")
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("HOME", t.TempDir())

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("FQDN guard let the lifecycle reach the orchestrator")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	exitCode, runErr := Run(context.Background(), Options{
		Config: &config.Config{
			Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
			Host:         config.Host{FQDN: "definitely-not-this-host.example.invalid"},
			Wrapper:      config.Wrapper{Version: "0.7.7"},
		},
		Headless: true,
		SkipBoot: true,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if exitCode != 1 || runErr == nil {
		t.Fatalf("Run = (%d, %v), want (1, error)", exitCode, runErr)
	}

	root := spanNamed(t, exporter, "cxx.lifecycle.run")
	if got := spanAttr(root, "wrapper.engine"); got != "codex" {
		t.Fatalf("wrapper.engine = %q, want codex", got)
	}
	if got := spanAttr(root, "wrapper.exit_code"); got != "1" {
		t.Fatalf("wrapper.exit_code = %q, want 1", got)
	}
	if got := spanAttr(root, "wrapper.headless"); got != "true" {
		t.Fatalf("wrapper.headless = %q, want true", got)
	}
	if spanAttr(root, "error.type") == "" {
		t.Fatal("a refused launch left the root span unmarked")
	}
	if root.Parent.IsValid() {
		t.Fatal("cxx.lifecycle.run must be a root span")
	}
}

func TestSyncSkillsEmitsSpanWithChangeFlag(t *testing.T) {
	exporter := startTestTracing(t)
	t.Setenv("HOME", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"skills":[{"slug":"git","sha256":"abc"}]}`)
	}))
	defer server.Close()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	if got := syncSkills(context.Background(), client, logger); !got.Updated || got.Err != nil {
		t.Fatalf("syncSkills = %+v, want a clean update", got)
	}

	span := spanNamed(t, exporter, "cxx.sync.skills")
	if got := spanAttr(span, "wrapper.skills_changed"); got != "true" {
		t.Fatalf("wrapper.skills_changed = %q, want true", got)
	}
	if got := spanAttr(span, "wrapper.engine"); got != "codex" {
		t.Fatalf("wrapper.engine = %q, want codex", got)
	}
}
