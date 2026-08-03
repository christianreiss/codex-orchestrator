package lifecycle

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
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

// startTestTracing turns tracing on with an in-memory exporter, so no socket is
// opened. Because Init is idempotent, a lifecycle that calls it again during
// the test reuses this pipeline — which is how a Run span reaches the exporter.
func startTestTracing(t *testing.T) *tracetest.InMemoryExporter {
	t.Helper()
	t.Setenv("CXX_OTEL_TRACES_ENABLED", "1")
	exporter := tracetest.NewInMemoryExporter()
	stop := tracing.Init(context.Background(), tracing.Options{
		Engine:   "claude",
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

func spansNamed(exporter *tracetest.InMemoryExporter, name string) []tracetest.SpanStub {
	var out []tracetest.SpanStub
	for _, s := range exporter.GetSpans() {
		if s.Name == name {
			out = append(out, s)
		}
	}
	return out
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
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "")

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
	if got := spanAttr(root, "wrapper.engine"); got != "claude" {
		t.Fatalf("wrapper.engine = %q, want claude", got)
	}
	if got := spanAttr(root, "wrapper.exit_code"); got != "1" {
		t.Fatalf("wrapper.exit_code = %q, want 1", got)
	}
	if spanAttr(root, "error.type") == "" {
		t.Fatal("a refused launch left the root span unmarked")
	}
	if root.Parent.IsValid() {
		t.Fatal("cxx.lifecycle.run must be a root span")
	}
}

// TestApplyClaudeArtifactsResultEmitsNestedSpans covers the function the bundle
// path actually calls. The bool wrapper applyClaudeArtifacts is only reached
// from tests, so instrumenting it instead would show green here and emit
// nothing in a shipped binary.
func TestApplyClaudeArtifactsResultEmitsNestedSpans(t *testing.T) {
	exporter := startTestTracing(t)
	t.Setenv("HOME", t.TempDir())

	ctx, parent := tracing.Start(context.Background(), "cxx.lifecycle.bootstrap")
	updated, err := applyClaudeArtifactsResult(ctx, &orchestrator.ClaudeArtifacts{
		Subagents:    []orchestrator.CollectionItem{item("reviewer", "sha-r", "review")},
		Commands:     []orchestrator.CollectionItem{item("deploy", "sha-d", "deploy")},
		OutputStyles: []orchestrator.CollectionItem{item("terse", "sha-t", "terse")},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	parent.End()
	if !updated || err != nil {
		t.Fatalf("apply = (%t, %v), want a clean update", updated, err)
	}

	artifacts := spanNamed(t, exporter, "cxx.apply.claude_artifacts")
	if got := spanAttr(artifacts, "wrapper.item_count"); got != "3" {
		t.Fatalf("wrapper.item_count = %q, want 3", got)
	}
	if got := spanAttr(artifacts, "wrapper.updated"); got != "true" {
		t.Fatalf("wrapper.updated = %q, want true", got)
	}
	bootstrapSpan := spanNamed(t, exporter, "cxx.lifecycle.bootstrap")
	if artifacts.Parent.SpanID() != bootstrapSpan.SpanContext.SpanID() {
		t.Fatal("cxx.apply.claude_artifacts did not nest under its caller's span")
	}

	collections := spansNamed(exporter, "cxx.apply.collection")
	if len(collections) != 3 {
		t.Fatalf("emitted %d collection spans, want one per kind", len(collections))
	}
	kinds := map[string]bool{}
	for _, s := range collections {
		kinds[spanAttr(s, "wrapper.collection_kind")] = true
		if s.Parent.SpanID() != artifacts.SpanContext.SpanID() {
			t.Fatalf("collection span %q did not nest under cxx.apply.claude_artifacts", spanAttr(s, "wrapper.collection_kind"))
		}
	}
	for _, kind := range []string{"subagent", "command", "output-style"} {
		if !kinds[kind] {
			t.Fatalf("no span for collection kind %q", kind)
		}
	}
}

func TestApplyClaudeSkillsResultEmitsSpan(t *testing.T) {
	exporter := startTestTracing(t)
	t.Setenv("HOME", t.TempDir())

	updated, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{
		skillItem("tdd", "sha-tdd", "---\nname: tdd\ndescription: x\n---\n"),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if !updated || err != nil {
		t.Fatalf("apply = (%t, %v), want a clean update", updated, err)
	}

	span := spanNamed(t, exporter, "cxx.apply.claude_skills")
	if got := spanAttr(span, "wrapper.item_count"); got != "1" {
		t.Fatalf("wrapper.item_count = %q, want 1", got)
	}
	if got := spanAttr(span, "wrapper.updated"); got != "true" {
		t.Fatalf("wrapper.updated = %q, want true", got)
	}
	if got := spanAttr(span, "wrapper.engine"); got != "claude" {
		t.Fatalf("wrapper.engine = %q, want claude", got)
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
}
