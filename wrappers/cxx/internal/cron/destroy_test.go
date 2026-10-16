package cron

import (
	"bytes"
	"context"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/enginedestroy"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
)

func TestApplyDestroyRequestsRunsOnceAndDropsEngine(t *testing.T) {
	home := t.TempDir()
	oldRun, oldReport, oldOpts := destroyEngine, reportDestroy, destroyOptions
	t.Cleanup(func() { destroyEngine, reportDestroy, destroyOptions = oldRun, oldReport, oldOpts })
	destroyOptions = func(context.Context, string) (enginedestroy.Options, error) {
		return enginedestroy.Options{Home: home}, nil
	}
	var ran, reports []string
	fail := false
	destroyEngine = func(_ context.Context, e string, _ enginedestroy.Options) (enginedestroy.Result, error) {
		ran = append(ran, e)
		r := enginedestroy.Result{Engine: e}
		if fail {
			r.Residue = []string{"x: boom"}
		}
		return r, nil
	}
	reportDestroy = func(_ context.Context, _ *config.Config, e, id, status string, _ []string) error {
		reports = append(reports, e+":"+id+":"+status)
		return nil
	}
	mk := func() map[string]*fleetconfig.Fetched {
		cfg := &config.Config{}
		cfg.Host.DestroyEngines = []config.DestroyDirective{{Engine: "grok", RequestID: "req-1"}}
		return map[string]*fleetconfig.Fetched{"claude": {Config: cfg}, "grok": {Config: cfg}}
	}

	// Failure: engine is still dropped from fetched, but no completion marker.
	fail = true
	f := mk()
	got := applyDestroyRequests(context.Background(), &config.Config{}, f, "/x/cxx", &bytes.Buffer{})
	if len(got) != 1 || got[0] != "grok" || f["grok"] != nil || f["claude"] == nil {
		t.Fatalf("got=%v fetched=%v", got, f)
	}
	if enginedestroy.Done(home, "grok", "req-1") {
		t.Fatal("failed run must not be marked done")
	}

	// Retry succeeds, marks done and reports.
	fail = false
	applyDestroyRequests(context.Background(), &config.Config{}, mk(), "/x/cxx", &bytes.Buffer{})
	if !enginedestroy.Done(home, "grok", "req-1") {
		t.Fatal("successful run must be marked done")
	}

	// Next tick: engine still dropped, but nothing runs again.
	ran = nil
	f = mk()
	applyDestroyRequests(context.Background(), &config.Config{}, f, "/x/cxx", &bytes.Buffer{})
	if len(ran) != 0 || f["grok"] != nil {
		t.Fatalf("ran=%v fetched grok=%v", ran, f["grok"])
	}
	want := []string{"grok:req-1:running", "grok:req-1:failed", "grok:req-1:running", "grok:req-1:done"}
	if len(reports) != len(want) {
		t.Fatalf("reports=%v", reports)
	}
	for i := range want {
		if reports[i] != want[i] {
			t.Fatalf("reports=%v", reports)
		}
	}
}
