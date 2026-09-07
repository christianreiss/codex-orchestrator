package codexapp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestAutomaticUploadNeverAcknowledgesLateNativeBytesAfterLogout(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	path, _ := codex.AuthPath()
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"logged-out"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	initial, _ := codex.CurrentAuthGeneration()
	if _, err := codex.MarkLogoutIntent(initial); err != nil {
		t.Fatal(err)
	}
	intent, _ := codex.CurrentLogoutIntentGeneration()
	late := []byte(`{"tokens":{"access_token":"late-native","refresh_token":"late-refresh"}}`)
	if err := os.WriteFile(path, late, 0o600); err != nil {
		t.Fatal(err)
	}
	child, err := codex.AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}
	defer child.Release()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified"}`))
	}))
	defer server.Close()
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL}}
	var stdout, stderr bytes.Buffer
	if code := cmdAuthUploadAuto(context.Background(), cfg, &stdout, &stderr); code != 0 || requests.Load() != 0 {
		t.Fatalf("automatic logout override=%d requests=%d stderr=%s", code, requests.Load(), stderr.String())
	}
	afterIntent, _ := codex.CurrentLogoutIntentGeneration()
	raw, _ := os.ReadFile(path)
	if intent != afterIntent || !bytes.Equal(raw, late) {
		t.Fatal("automatic upload normalized late bytes or acknowledged explicit logout")
	}
	// The public command remains an intentional explicit-login action.
	stdout.Reset()
	stderr.Reset()
	if code := cmdAuthUpload(context.Background(), cfg, &stdout, &stderr); code != 0 || requests.Load() != 1 {
		t.Fatalf("explicit upload changed contract=%d requests=%d stderr=%s", code, requests.Load(), stderr.String())
	}
	if active, err := codex.LogoutIntentActive(); err != nil || active {
		t.Fatalf("explicit accepted upload did not acknowledge logout: %v %v", active, err)
	}
}

func TestAutomaticUploadCreatesPurgeOnlyAfterConfirmedNativeCandidate(t *testing.T) {
	for _, state := range []string{"outage", "pending", "accepted", "canonical winner", "different accepted pair"} {
		t.Run(state, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("CODEX_HOME", t.TempDir())
			path, _ := codex.AuthPath()
			local := []byte(`{"last_refresh":"2026-08-08T10:00:00Z","tokens":{"access_token":"local"}}`)
			if err := os.WriteFile(path, local, 0o600); err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var request struct {
					Command string `json:"command"`
				}
				_ = json.NewDecoder(r.Body).Decode(&request)
				if request.Command != "store" {
					t.Error("automatic command retrieved credentials")
				}
				if state == "outage" {
					http.Error(w, "unavailable", http.StatusServiceUnavailable)
					return
				}
				status, verification := "updated", "verified"
				if state == "pending" {
					verification = "pending"
				}
				if state == "canonical winner" {
					status = "outdated"
				}
				response := map[string]any{"status": status, "verification_state": verification, "engine": "codex", "host": map[string]bool{"secure": false}}
				if state == "canonical winner" || state == "different accepted pair" {
					response["auth"] = json.RawMessage(`{"last_refresh":"2026-08-08T11:00:00Z","tokens":{"access_token":"canonical"}}`)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(response)
			}))
			defer server.Close()
			cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: server.URL}}
			var stdout, stderr bytes.Buffer
			code := cmdAuthUploadAuto(context.Background(), cfg, &stdout, &stderr)
			wantSuccess := state == "accepted" || state == "canonical winner"
			if (code == 0) != wantSuccess || calls.Load() == 0 {
				t.Fatalf("automatic %s code=%d calls=%d stderr=%s", state, code, calls.Load(), stderr.String())
			}
			raw, err := os.ReadFile(path)
			if state == "accepted" {
				if !os.IsNotExist(err) {
					t.Fatal("confirmed insecure candidate was not purged")
				}
			} else if err != nil || !bytes.Equal(raw, local) {
				t.Fatalf("automatic %s overwrote or purged unconfirmed native bytes", state)
			}
			if state != "accepted" {
				requestFile := filepath.Join(filepath.Dir(path), ".cdx-insecure-purge-request")
				requests, _ := os.ReadFile(requestFile)
				var doc struct {
					Requests map[string]string `json:"requests"`
				}
				_ = json.Unmarshal(requests, &doc)
				if len(doc.Requests) != 0 {
					t.Fatal("unconfirmed automatic candidate created purge request")
				}
			}
		})
	}
}
