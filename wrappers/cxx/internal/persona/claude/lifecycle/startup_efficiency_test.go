package lifecycle

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHiddenBootKeepsClaudeQuotaAdvisory(t *testing.T) {
	now := time.Now().UTC()
	reset := now.Add(5 * time.Hour).Format(time.RFC3339)
	extra := fmt.Sprintf(`,"quota_hard_fail":true,"quota_limit_percent":95,"claude_usage":{
		"status":"ok","fetched_at":%q,"five_hour_used_percent":96,"five_hour_resets_at":%q,
		"seven_day_used_percent":null,"seven_day_resets_at":null,
		"five_hour_window":{"used_percent":96,"resets_at":%q},
		"seven_day_window":{"used_percent":null,"resets_at":null}}}`, now.Format(time.RFC3339), reset, reset)
	cfg, home := syncOnlyHost(t, extra)
	t.Setenv("CLX_CLAUDE_BIN", filepath.Join(home, "no-cli"))
	stderr := captureStderr(t, func() {
		exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
		if exit != 0 || err != nil {
			t.Fatalf("advisory quota blocked managed sync: exit=%d err=%v", exit, err)
		}
	})
	if !strings.Contains(stderr, "clx quota:") || !strings.Contains(stderr, "96%") {
		t.Fatalf("hidden screen omitted Claude usage warning: %q", stderr)
	}
}

func TestNativeSkillBundleAvoidsRedundantList(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		advertised bool
		writeFails bool
	}{
		{name: "native_skills", advertised: true},
		{name: "legacy_server"},
		{name: "failed_native_manifest", advertised: true, writeFails: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			cfg, home := syncOnlyHost(t, "")
			t.Setenv("CLX_CLAUDE_BIN", filepath.Join(home, "no-cli"))
			if scenario.writeFails {
				if err := os.MkdirAll(collectionManifestPath("skills"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			var listCalls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/skills" {
					listCalls.Add(1)
					// A deterministic RTT makes the avoidable startup wait visible
					// without relying on production network or credentials.
					time.Sleep(40 * time.Millisecond)
					_, _ = io.WriteString(w, `{"skills":[]}`)
					return
				}
				if r.URL.Path != "/sync/bootstrap" {
					http.NotFound(w, r)
					return
				}
				extra := ""
				if scenario.advertised {
					extra = `,"claude_skills":[]`
				}
				_, _ = fmt.Fprintf(w, `{"status":"ok","auth":{"status":"valid","verification_state":"verified","host":{"secure":true}}%s}`, extra)
			}))
			defer server.Close()
			cfg.Orchestrator.BaseURL = server.URL
			started := time.Now()
			exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
			t.Logf("startup=%s skills_list_requests=%d", time.Since(started), listCalls.Load())
			if scenario.writeFails {
				if exit != 1 || err == nil || !strings.Contains(err.Error(), "managed sync incomplete") {
					t.Fatalf("native skill failure was hidden: exit=%d err=%v", exit, err)
				}
			} else if exit != 0 || err != nil {
				t.Fatalf("Run() = %d, %v", exit, err)
			}
			want := int32(1)
			if scenario.advertised {
				want = 0
			}
			if got := listCalls.Load(); got != want {
				t.Fatalf("skills list requests = %d, want %d", got, want)
			}
		})
	}
}
