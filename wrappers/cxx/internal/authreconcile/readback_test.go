package authreconcile

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestReadbackFailureNeverLeaksBodiesOrRetries(t *testing.T) {
	for _, scenario := range []string{"expired", "api_expired", "gateway", "malformed", "canceled"} {
		t.Run(scenario, func(t *testing.T) {
			var calls atomic.Int32
			release := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				switch scenario {
				case "expired":
					w.WriteHeader(409)
					_, _ = w.Write([]byte(`{"code":"account_session_invalid","message":"fixture-sensitive-token"}`))
				case "api_expired":
					w.WriteHeader(404)
					_, _ = w.Write([]byte(`{"status":"error","code":"not_found","message":"Account session not found"}`))
				case "gateway":
					w.WriteHeader(503)
					_, _ = w.Write([]byte(`{"message":"fixture-sensitive-token"}`))
				case "malformed":
					_, _ = w.Write([]byte(`{"auth":"fixture-sensitive-token`))
				case "canceled":
					<-release
				}
			}))
			defer server.Close()
			client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "fixture"})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			_, err = readback(ctx, client, "codex", 7, "expired-fixture")
			close(release)
			if err == nil || strings.Contains(err.Error(), "fixture-sensitive-token") {
				t.Fatalf("unsafe readback error: %v", err)
			}
			if (scenario == "expired" || scenario == "api_expired") && !strings.Contains(err.Error(), "session binding is expired or no longer exists") {
				t.Fatal("expired binding not named precisely")
			}
			if calls.Load() != 1 {
				t.Fatalf("readback repeated effects: %d", calls.Load())
			}
		})
	}
}

func TestRecoveryHelpDoesNotSelectNativeHelp(t *testing.T) {
	for _, args := range [][]string{{"auth-reconcile", "--help"}, {"--config", "/fixture/config.json", "auth-reconcile", "-h"}} {
		if !HelpRequested(args) {
			t.Fatalf("recovery help missed: %v", args)
		}
	}
	for _, args := range [][]string{{"run", "--", "auth-reconcile", "--help"}, {"--execute", "auth-reconcile", "--help"}, {"--config", "auth-reconcile", "--help"}} {
		if HelpRequested(args) {
			t.Fatalf("native/config value mistaken for recovery: %v", args)
		}
	}
}
