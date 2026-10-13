package authreconcile

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestRealRecoveryCommandWithoutNativeLease(t *testing.T) {
	root := t.TempDir()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	key := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	binary := filepath.Join(root, "cxx")
	build := exec.Command("go", "build", "-o", binary, "-ldflags", "-X main.Version=0.9.79 -X github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing.buildPublicKeyB64="+key, "./cmd/cxx")
	build.Dir = "../.."
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build failed: %v %s", err, out)
	}
	for _, engine := range []string{"codex", "claude"} {
		for _, protocol := range []int{0, 1} {
			t.Run(fmt.Sprintf("%s/protocol%d", engine, protocol), func(t *testing.T) {
				b, local, s := fixture(t, engine)
				var retrieves, stores, leases, other atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					if strings.HasPrefix(r.URL.Path, "/auth/sessions") {
						leases.Add(1)
					}
					if r.URL.Path != "/auth" {
						other.Add(1)
						http.Error(w, "unexpected", 500)
						return
					}
					if body["command"] != "retrieve" {
						stores.Add(1)
						http.Error(w, "store forbidden", 500)
						return
					}
					retrieves.Add(1)
					if body["engine"] != engine || body["account_id"] != float64(7) {
						t.Errorf("wrong readback binding: %v", body)
					}
					if body["session_id"] != nil {
						w.WriteHeader(409)
						_, _ = w.Write([]byte(`{"code":"account_session_invalid"}`))
						return
					}
					_ = json.NewEncoder(w).Encode(s)
				}))
				defer server.Close()
				accountpool.Load(engine, b.path, server.URL).Observe("/auth", []byte(`{"account_id":7,"verification_state":"verified","account_pool":true}`))
				cfgPath := filepath.Join(root, engine+".json")
				host, _ := os.Hostname()
				cfg := config.Config{SchemaVersion: 1, Engine: engine, IssuedAt: "2026-10-13T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture-key", InstallationID: "fixture"}, Host: config.Host{ID: 42, FQDN: host, Secure: true, Engines: "codex,claude,grok", EnginesList: []string{"codex", "claude", "grok"}}, Wrapper: config.Wrapper{Version: "0.9.79", Track: "stable", BinaryURL: server.URL + "/download", BinarySHA256: strings.Repeat("0", 64)}}
				cfg.Orchestrator.CommunicatorProtocol = protocol
				cfg.Orchestrator.CommunicatorSyncProtocol = protocol
				raw, _ := json.Marshal(cfg)
				if err := os.WriteFile(cfgPath, raw, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(cfgPath+".sig", ed25519.Sign(priv, raw), 0600); err != nil {
					t.Fatal(err)
				}
				runtimeRoot, err := os.MkdirTemp("", "cc-reconcile-")
				if err != nil {
					t.Fatal(err)
				}
				defer os.RemoveAll(runtimeRoot)
				env := append(os.Environ(), "XDG_RUNTIME_DIR="+runtimeRoot, "CXX_PROVIDER_SESSION_ID=expired-lease-fixture")
				help := exec.Command(binary, engine, "auth-reconcile", "--help")
				help.Env = env
				if out, err := help.CombinedOutput(); err != nil || !strings.Contains(string(out), "--accept-server") {
					t.Fatalf("recovery help unavailable: %v %s", err, out)
				}
				run := func(accept bool) Report {
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					defer cancel()
					args := []string{engine, "--config", cfgPath, "auth-reconcile"}
					if accept {
						args = append(args, "--accept-server")
					}
					cmd := exec.CommandContext(ctx, binary, args...)
					cmd.Env = env
					var stdout, stderr bytes.Buffer
					cmd.Stdout = &stdout
					cmd.Stderr = &stderr
					if err := cmd.Run(); err != nil {
						t.Fatalf("command failed: %v stdout=%s stderr=%s", err, stdout.String(), stderr.String())
					}
					if strings.Contains(stdout.String()+stderr.String(), "fixture-secret") {
						t.Fatal("CLI leaked credential tokens")
					}
					var report Report
					if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
						t.Fatalf("unexpected command output: %v %s", err, stdout.String())
					}
					if accept && (!strings.Contains(stderr.String(), "Adopted server credentials") || !strings.Contains(stderr.String(), "interrupted upload remains unacknowledged")) {
						t.Fatal("CLI claimed upload acknowledgement")
					}
					return report
				}
				inspection := run(false)
				if !inspection.InactiveSessionOmitted || inspection.AccountID != 7 || inspection.ServerGeneration != 42 || inspection.Adopted {
					t.Fatalf("inspection could not read expired binding: %+v", inspection)
				}
				before, _ := os.ReadFile(b.path)
				if !bytes.Equal(before, local) {
					t.Fatal("inspection wrote credentials")
				}
				accepted := run(true)
				if !accepted.Adopted || accepted.Backup == "" {
					t.Fatal("explicit no-session recovery did not adopt")
				}
				backup, _ := os.ReadFile(accepted.Backup)
				if !bytes.Equal(backup, local) {
					t.Fatal("lost local original backup")
				}
				if retrieves.Load() != 2 || stores.Load() != 0 || leases.Load() != 0 || other.Load() != 0 {
					t.Fatalf("unexpected effects: reads=%d stores=%d leases=%d other=%d", retrieves.Load(), stores.Load(), leases.Load(), other.Load())
				}
				_ = filepath.Walk(runtimeRoot, func(path string, info os.FileInfo, err error) error {
					if err == nil && filepath.Base(path) == "control.sock" {
						t.Error("diagnostic started a communicator owner")
					}
					return nil
				})
				home, _ := os.UserHomeDir()
				for _, rel := range []string{".cxx/native-bin", ".config/systemd/user", ".local/bin/codex", ".local/bin/claude"} {
					if _, err := os.Stat(filepath.Join(home, rel)); !os.IsNotExist(err) {
						t.Fatalf("recovery performed installation: %s", rel)
					}
				}
				t.Logf("%s real command: two readbacks, zero stores/leases/startup operations; account7 expired lease omitted", engine)
			})
		}
	}
	cmd := exec.Command(binary, "grok", "auth-reconcile")
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "unsupported") || !strings.Contains(string(out), "server-owned") {
		t.Fatalf("Grok recovery was not explicitly unsupported: %v %s", err, out)
	}
}
