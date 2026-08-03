//go:build cxx_otel

package tracing

// Everything here needs the real SDK, so it only builds and runs under
// `-tags cxx_otel`. That includes the egress regression, which is the most
// important test in this package — CI runs a tagged vet+test step so it keeps
// being executed even though the release artifact is untagged.

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// recorder captures every request an httptest collector receives.
type recorder struct {
	mu       sync.Mutex
	requests []recordedRequest
}

type recordedRequest struct {
	header http.Header
	body   string
}

func (r *recorder) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		r.mu.Lock()
		r.requests = append(r.requests, recordedRequest{header: req.Header.Clone(), body: string(body)})
		r.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}
}

func (r *recorder) snapshot() []recordedRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recordedRequest(nil), r.requests...)
}

// --- the gate -------------------------------------------------------------

func TestInjectedExporterCannotEnableTracing(t *testing.T) {
	clearAmbientOTEL(t)
	exporter := tracetest.NewInMemoryExporter()
	stop := Init(context.Background(), Options{Engine: "codex", Logger: quietLogger(), Exporter: exporter})
	t.Cleanup(stop)

	if Enabled() {
		t.Fatal("an injected exporter must not switch tracing on by itself")
	}
	_, span := Start(context.Background(), "cxx.lifecycle.run")
	span.End()
	if got := len(exporter.GetSpans()); got != 0 {
		t.Fatalf("recorded %d spans while disabled, want 0", got)
	}
}

func TestEnabledProducesNestedSpans(t *testing.T) {
	clearAmbientOTEL(t)
	t.Setenv(EnvEnabled, "1")
	exporter := tracetest.NewInMemoryExporter()
	stop := Init(context.Background(), Options{Engine: "claude", Version: "9.9.9", Logger: quietLogger(), Exporter: exporter})
	t.Cleanup(stop)

	if !Enabled() {
		t.Fatal("tracing off with CXX_OTEL_TRACES_ENABLED=1")
	}

	ctx, root := Start(context.Background(), "cxx.lifecycle.run", String("wrapper.engine", "claude"))
	childCtx, child := Start(ctx, "cxx.lifecycle.bootstrap", Bool("wrapper.concurrent", false))
	_, grandchild := Start(childCtx, "cxx.apply.claude_skills", Int("wrapper.item_count", 3))
	grandchild.End()
	child.End()
	root.SetInt("wrapper.exit_code", 0)
	root.End()

	spans := exporter.GetSpans()
	if len(spans) != 3 {
		t.Fatalf("recorded %d spans, want 3", len(spans))
	}
	byName := map[string]tracetest.SpanStub{}
	for _, s := range spans {
		byName[s.Name] = s
	}
	root0, ok := byName["cxx.lifecycle.run"]
	if !ok {
		t.Fatalf("root span missing; got %v", spans)
	}
	boot, ok := byName["cxx.lifecycle.bootstrap"]
	if !ok {
		t.Fatalf("bootstrap span missing; got %v", spans)
	}
	apply, ok := byName["cxx.apply.claude_skills"]
	if !ok {
		t.Fatalf("apply span missing; got %v", spans)
	}
	if boot.Parent.SpanID() != root0.SpanContext.SpanID() {
		t.Fatal("bootstrap span is not a child of the run span")
	}
	if apply.Parent.SpanID() != boot.SpanContext.SpanID() {
		t.Fatal("apply span is not a child of the bootstrap span")
	}
	if got := attrString(root0, "wrapper.engine"); got != "claude" {
		t.Fatalf("wrapper.engine = %q, want claude", got)
	}
	// Int and Bool have to survive the SDK-free Attr union too.
	if got := attrString(byName["cxx.apply.claude_skills"], "wrapper.item_count"); got != "3" {
		t.Fatalf("wrapper.item_count = %q, want 3", got)
	}
	if got := attrString(byName["cxx.lifecycle.bootstrap"], "wrapper.concurrent"); got != "false" {
		t.Fatalf("wrapper.concurrent = %q, want false", got)
	}
	if got := attrString(root0, "service.name"); got != defaultServiceName {
		// service.name lives on the resource, not the span; check it there.
		if res := resourceString(root0, "service.name"); res != defaultServiceName {
			t.Fatalf("service.name = %q, want %q", res, defaultServiceName)
		}
	}
	if res := resourceString(root0, "service.version"); res != "9.9.9" {
		t.Fatalf("service.version = %q, want 9.9.9", res)
	}
}

// --- the regression that matters -----------------------------------------

// TestBareOTELVarsDoNotEnableTracing is the cheap half: internal/codex.PreExec
// exports OTEL_EXPORTER_OTLP_ENDPOINT into this very process for the child
// Codex CLI, and that must not switch the wrapper's own tracing on.
func TestBareOTELVarsDoNotEnableTracing(t *testing.T) {
	clearAmbientOTEL(t)
	decoy := &recorder{}
	decoyServer := httptest.NewServer(decoy.handler())
	defer decoyServer.Close()

	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", decoyServer.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", decoyServer.URL+"/v1/traces")
	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	t.Setenv("OTEL_SERVICE_NAME", "cdx")

	stop := Init(context.Background(), Options{Engine: "codex", Logger: quietLogger()})
	t.Cleanup(stop)

	if Enabled() {
		t.Fatal("a bare OTEL_* variable switched the wrapper's own tracing on")
	}
	_, span := Start(context.Background(), "cxx.lifecycle.run")
	span.End()
	stop()

	if got := len(decoy.snapshot()); got != 0 {
		t.Fatalf("the Codex CLI's collector received %d requests from the wrapper, want 0", got)
	}
}

// TestEnabledTracingIgnoresBareOTELConfiguration is the half that catches real
// egress. Tracing is ON — so the exporter genuinely runs — while every bare
// OTEL_* variable points somewhere else. PreExec fills
// OTEL_EXPORTER_OTLP_HEADERS from the user's ~/.codex/config.toml, which
// routinely holds a bearer token, so the header channel matters as much as the
// endpoint.
//
// This test opens loopback sockets rather than using an in-memory exporter on
// purpose: the resolved destination and headers of the real OTLP client are not
// observable any other way, and asserting on our own resolver would only prove
// that our code is consistent with itself.
func TestEnabledTracingIgnoresBareOTELConfiguration(t *testing.T) {
	clearAmbientOTEL(t)

	mine := &recorder{}
	mineServer := httptest.NewServer(mine.handler())
	defer mineServer.Close()

	decoy := &recorder{}
	decoyServer := httptest.NewServer(decoy.handler())
	defer decoyServer.Close()

	t.Setenv(EnvEnabled, "true")
	t.Setenv(EnvEndpoint, mineServer.URL+"/v1/traces")
	t.Setenv(EnvServiceName, "cxx-under-test")

	// Everything below belongs to the child Codex CLI, not to us.
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", decoyServer.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", decoyServer.URL+"/v1/traces")
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Bearer%20leaked-codex-token")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "Authorization=Bearer%20leaked-codex-token")
	t.Setenv("OTEL_EXPORTER_OTLP_COMPRESSION", "gzip")
	t.Setenv("OTEL_EXPORTER_OTLP_TIMEOUT", "60000")
	// If the SDK were left to autoconfigure, this alone would drop every span.
	t.Setenv("OTEL_TRACES_SAMPLER", "always_off")
	t.Setenv("OTEL_SERVICE_NAME", "leaked-service-name")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "leaked.attribute=leaked-value")

	stop := Init(context.Background(), Options{Engine: "codex", Version: "1.2.3", Logger: quietLogger()})
	if !Enabled() {
		stop()
		t.Fatal("tracing did not start")
	}
	_, span := Start(context.Background(), "cxx.lifecycle.run", String("wrapper.engine", "codex"))
	span.End()
	stop() // flushes the batch processor

	if got := len(decoy.snapshot()); got != 0 {
		t.Fatalf("the Codex CLI's collector received %d span exports, want 0", got)
	}
	requests := mine.snapshot()
	if len(requests) != 1 {
		t.Fatalf("the wrapper's own collector received %d exports, want 1", len(requests))
	}
	req := requests[0]
	if v := req.header.Get("Authorization"); v != "" {
		t.Fatalf("export carried an Authorization header from OTEL_EXPORTER_OTLP_HEADERS: %q", v)
	}
	for key, values := range req.header {
		for _, v := range values {
			if strings.Contains(v, "leaked-codex-token") {
				t.Fatalf("header %s leaked the Codex bearer token", key)
			}
		}
	}
	if enc := req.header.Get("Content-Encoding"); enc != "" {
		t.Fatalf("Content-Encoding = %q, want none (OTEL_EXPORTER_OTLP_COMPRESSION must not apply)", enc)
	}
	// The payload is OTLP protobuf; string fields appear verbatim in it.
	if !strings.Contains(req.body, "cxx-under-test") {
		t.Fatal("exported resource does not carry CXX_OTEL_SERVICE_NAME")
	}
	for _, leak := range []string{"leaked-service-name", "leaked.attribute", "leaked-value"} {
		if strings.Contains(req.body, leak) {
			t.Fatalf("exported payload carries %q from a bare OTEL_* variable", leak)
		}
	}

	// The scrub is temporary: the child Codex CLI still needs every one of
	// these, and PreExec runs long after Init.
	for key, want := range map[string]string{
		"OTEL_EXPORTER_OTLP_ENDPOINT": decoyServer.URL,
		"OTEL_EXPORTER_OTLP_HEADERS":  "Authorization=Bearer%20leaked-codex-token",
		"OTEL_TRACES_SAMPLER":         "always_off",
		"OTEL_SERVICE_NAME":           "leaked-service-name",
		"OTEL_RESOURCE_ATTRIBUTES":    "leaked.attribute=leaked-value",
	} {
		if got, ok := os.LookupEnv(key); !ok || got != want {
			t.Fatalf("%s = %q (present %t) after Init; the child Codex CLI's environment must be restored exactly", key, got, ok)
		}
	}
}

// TestExporterOptionsCoverEveryEnvReachableField is the untagged
// TestHeadersAreAlwaysNonNil's other half: the option list itself only exists
// in this build.
func TestExporterOptionsCoverEveryEnvReachableField(t *testing.T) {
	cfg := ConfigFromEnv(func(string) string { return "" })
	opts := newExporterOptions(cfg)
	if len(opts) != 6 {
		t.Fatalf("newExporterOptions returned %d options; every env-reachable field needs one", len(opts))
	}
}

// --- span hygiene ---------------------------------------------------------

func TestFailRecordsTypeNameNeverMessage(t *testing.T) {
	clearAmbientOTEL(t)
	t.Setenv(EnvEnabled, "on")
	exporter := tracetest.NewInMemoryExporter()
	stop := Init(context.Background(), Options{Engine: "codex", Logger: quietLogger(), Exporter: exporter})
	t.Cleanup(stop)

	_, span := Start(context.Background(), "cxx.sync.bootstrap")
	span.Fail(tokenError{})
	span.End()

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans, want 1", len(spans))
	}
	got := spans[0]
	if got.Status.Description != "tracing.tokenError" {
		t.Fatalf("status description = %q, want the error's type name", got.Status.Description)
	}
	if attrString(got, "error.type") != "tracing.tokenError" {
		t.Fatalf("error.type = %q", attrString(got, "error.type"))
	}
	for _, kv := range got.Attributes {
		if strings.Contains(kv.Value.Emit(), "sk-live-do-not-log") {
			t.Fatalf("attribute %s leaked the error message", kv.Key)
		}
	}
	if strings.Contains(got.Status.Description, "sk-live-do-not-log") {
		t.Fatal("status description leaked the error message")
	}
}

func TestFailOnNilErrorLeavesSpanUnset(t *testing.T) {
	clearAmbientOTEL(t)
	t.Setenv(EnvEnabled, "1")
	exporter := tracetest.NewInMemoryExporter()
	stop := Init(context.Background(), Options{Engine: "codex", Logger: quietLogger(), Exporter: exporter})
	t.Cleanup(stop)

	_, span := Start(context.Background(), "cxx.sync.skills")
	span.Fail(nil)
	span.End()

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans, want 1", len(spans))
	}
	if attrString(spans[0], "error.type") != "" {
		t.Fatal("Fail(nil) marked the span as failed")
	}
}

// --- teardown -------------------------------------------------------------

func TestShutdownIsIdempotentAndDisablesTracing(t *testing.T) {
	clearAmbientOTEL(t)
	t.Setenv(EnvEnabled, "1")
	exporter := tracetest.NewInMemoryExporter()
	stop := Init(context.Background(), Options{Engine: "codex", Logger: quietLogger(), Exporter: exporter})
	if !Enabled() {
		stop()
		t.Fatal("tracing did not start")
	}
	stop()
	stop()
	if Enabled() {
		t.Fatal("tracing still enabled after shutdown")
	}
	ctx := context.Background()
	got, span := Start(ctx, "cxx.lifecycle.run")
	span.End()
	if got != ctx {
		t.Fatal("Start after shutdown must behave like the disabled path")
	}
}

func TestBrokenEndpointDoesNotEnableOrPanic(t *testing.T) {
	clearAmbientOTEL(t)
	t.Setenv(EnvEnabled, "1")
	// A URL the exporter cannot resolve into a host must degrade to "off",
	// never to "off by accident somewhere else".
	t.Setenv(EnvEndpoint, "://not-a-url")
	stop := Init(context.Background(), Options{Engine: "codex", Logger: quietLogger()})
	t.Cleanup(stop)
	_, span := Start(context.Background(), "cxx.lifecycle.run")
	span.End()
}

// --- helpers --------------------------------------------------------------

func attrString(s tracetest.SpanStub, key string) string {
	for _, kv := range s.Attributes {
		if string(kv.Key) == key {
			return kv.Value.Emit()
		}
	}
	return ""
}

func resourceString(s tracetest.SpanStub, key string) string {
	if s.Resource == nil {
		return ""
	}
	for _, kv := range s.Resource.Attributes() {
		if string(kv.Key) == key {
			return kv.Value.Emit()
		}
	}
	return ""
}

var _ sdktrace.SpanExporter = (*tracetest.InMemoryExporter)(nil)
