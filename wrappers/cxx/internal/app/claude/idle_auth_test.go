package claudeapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestAutomaticUploadCannotAcknowledgeAnyExplicitLogout(t *testing.T) {
	for _, different := range []bool{false, true} {
		t.Run(fmt.Sprint(different), func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			if err := claude.WriteAuth(json.RawMessage(`{"claudeAiOauth":{"accessToken":"old"}}`)); err != nil {
				t.Fatal(err)
			}
			before, _ := claude.ReadAuthSnapshot(false)
			if _, err := claude.RecordDeferredExplicitLogout(before.Generation); err != nil {
				t.Fatal(err)
			}
			path, _ := claude.AuthPath()
			if different {
				_ = os.WriteFile(path, []byte(`{"claudeAiOauth":{"accessToken":"different-native-login"}}`), 0o600)
			}
			marker, _ := claude.CurrentLogoutIntentGeneration()
			native, _ := os.ReadFile(path)
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				_, _ = fmt.Fprintf(w, `{"status":"updated","verification_state":"verified","canonical_digest":%q}`, strings.Repeat("c", 64))
			}))
			defer server.Close()
			cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
			var stderr bytes.Buffer
			if code := cmdAutomaticAuthUpload(context.Background(), cfg, slog.New(slog.DiscardHandler), &stderr); code != 0 {
				t.Fatalf("exit=%d err=%s", code, stderr.String())
			}
			if calls.Load() != 0 {
				t.Fatal("unattended upload crossed explicit logout")
			}
			if after, _ := claude.CurrentLogoutIntentGeneration(); after != marker {
				t.Fatal("automatic upload erased/replaced logout intent")
			}
			if after, _ := os.ReadFile(path); string(after) != string(native) {
				t.Fatal("automatic logout hold mutated native credentials")
			}
		})
	}
}

func TestAutomaticUploadBindsAcceptedGenerationAndSkipsNoOp(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path, _ := claude.AuthPath()
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	native := []byte(`{"claudeAiOauth":{"accessToken":"native"},"mcpOAuth":{"local":"private"}}`)
	_ = os.WriteFile(path, native, 0o600)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if body["command"] != "store" {
			t.Error("automatic upload downloaded canonical credentials")
		}
		_, _ = fmt.Fprintf(w, `{"status":"updated","verification_state":"verified","canonical_digest":%q,"host":{"secure":true},"auth":{"claudeAiOauth":{"accessToken":"native"},"mcpOAuth":{"foreign":"must-not-materialize"}}}`, strings.Repeat("c", 64))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
	for range 2 {
		var stderr bytes.Buffer
		if code := cmdAutomaticAuthUpload(context.Background(), cfg, slog.New(slog.DiscardHandler), &stderr); code != 0 {
			t.Fatalf("exit=%d err=%s", code, stderr.String())
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("accepted generation re-uploaded: %d", calls.Load())
	}
	snap, _ := claude.ReadAuthSnapshot(false)
	if snap.ServerDigest != strings.Repeat("c", 64) || string(snap.Raw) != string(native) {
		t.Fatal("automatic upload did not bind native bytes without materialization")
	}
}

func TestAutomaticUploadFailureKeepsPendingInsecureCredentials(t *testing.T) {
	for _, outcome := range []string{"unreachable", "outdated", "replacement"} {
		t.Run(outcome, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			path, _ := claude.AuthPath()
			_ = os.MkdirAll(filepath.Dir(path), 0o700)
			native := []byte(`{"claudeAiOauth":{"accessToken":"pending"}}`)
			_ = os.WriteFile(path, native, 0o600)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if outcome == "unreachable" {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				status := "outdated"
				if outcome == "replacement" {
					status = "updated"
				}
				_, _ = fmt.Fprintf(w, `{"status":%q,"verification_state":"verified","canonical_digest":%q,"canonical_last_refresh":"2026-09-07T10:00:00Z","auth":{"claudeAiOauth":{"accessToken":"remote"}}}`, status, strings.Repeat("c", 64))
			}))
			defer server.Close()
			cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
			var stderr bytes.Buffer
			if code := cmdAutomaticAuthUpload(context.Background(), cfg, slog.New(slog.DiscardHandler), &stderr); code != 1 {
				t.Fatalf("failed store exit=%d", code)
			}
			if raw, _ := os.ReadFile(path); string(raw) != string(native) {
				t.Fatal("failed automatic upload purged or replaced pending native credentials")
			}
			if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".clx", "auth", "purge-on-last-exit")); !os.IsNotExist(err) {
				t.Fatalf("failed upload created purge request: %v", err)
			}
		})
	}
}
