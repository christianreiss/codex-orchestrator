package communicator

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

// Status does not enter the native lifecycle. Exercise actual option parsing,
// signature verification and expiry repair before its first control request.
func TestRecoveredAndCustomConfigsRouteEveryEngineStatus(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the real signed wrapper")
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	key := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	binary := filepath.Join(t.TempDir(), "cxx")
	build := exec.Command("go", "build", "-o", binary, "-ldflags", "-X github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing.buildPublicKeyB64="+key, "./cmd/cxx")
	build.Dir = "../.."
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	for _, engine := range []string{"codex", "claude", "grok"} {
		for _, mode := range []string{"expired-default", "custom-path"} {
			t.Run(engine+"/"+mode, func(t *testing.T) {
				root, err := os.MkdirTemp("", "cc-recover-")
				if err != nil {
					t.Fatal(err)
				}
				defer os.RemoveAll(root)
				var directControl, control, repairs atomic.Int32
				var fresh []byte
				reply := []byte(`{"status":"valid","verification_state":"verified","host":{"secure":true},"versions":{}}`)
				wsHandler := websocket.Handler(func(ws *websocket.Conn) {
					defer ws.Close()
					for {
						var f frame
						if websocket.JSON.Receive(ws, &f) != nil {
							return
						}
						switch f.Type {
						case "hello":
							_ = websocket.JSON.Send(ws, frame{Type: "ready", Protocol: 1})
						case "request":
							control.Add(1)
							_ = websocket.JSON.Send(ws, frame{ID: f.ID, Status: 200, Body: reply})
						case "heartbeat":
							_ = websocket.JSON.Send(ws, frame{Type: "heartbeat"})
						}
					}
				})
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/wrapper/v2/config":
						repairs.Add(1)
						_ = json.NewEncoder(w).Encode(map[string]any{"payload": json.RawMessage(fresh), "signature": map[string]string{"value": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, fresh))}})
					case "/host/communicator/connect":
						wsHandler.ServeHTTP(w, r)
					default:
						directControl.Add(1)
						_, _ = w.Write(reply)
					}
				}))
				defer upstream.Close()
				cfg := config.Config{SchemaVersion: 1, Engine: engine, IssuedAt: time.Now().UTC().Format(time.RFC3339), Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "fixture-host-key", InstallationID: "fixture", CommunicatorProtocol: 1}, Host: config.Host{ID: 1, FQDN: "fixture.example", Secure: true}, Wrapper: config.Wrapper{Version: "0.9.77", Track: "stable", BinaryURL: upstream.URL + "/wrapper/v2/download", BinarySHA256: strings.Repeat("0", 64)}}
				fresh, _ = json.Marshal(cfg)
				if mode == "expired-default" {
					past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
					cfg.ExpiresAt = &past
				}
				path := filepath.Join(root, "selected.json")
				raw, _ := json.Marshal(cfg)
				if err := os.WriteFile(path, raw, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path+".sig", ed25519.Sign(priv, raw), 0600); err != nil {
					t.Fatal(err)
				}
				t.Setenv("XDG_RUNTIME_DIR", root)
				socket, err := socketPath(upstream.URL)
				if err != nil {
					t.Fatal(err)
				}
				defer func() {
					res, err := unixClient(socket, time.Second).Get("http://communicator.local/_comm/status")
					if err != nil {
						return
					}
					defer res.Body.Close()
					var status struct {
						PID int `json:"pid"`
					}
					if json.NewDecoder(res.Body).Decode(&status) == nil && status.PID > 0 {
						p, _ := os.FindProcess(status.PID)
						_ = p.Kill()
					}
				}()
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				binDir := filepath.Join(root, "bin")
				if err := os.Mkdir(binDir, 0700); err != nil {
					t.Fatal(err)
				}
				for _, e := range []string{"codex", "claude", "grok"} {
					if err := os.WriteFile(filepath.Join(binDir, e), []byte("#!/bin/sh\necho '1.0.50'\n"), 0700); err != nil {
						t.Fatal(err)
					}
				}
				args := []string{engine}
				env := []string{"PATH=" + binDir + ":/usr/bin:/bin", "HOME=" + root, "XDG_CONFIG_HOME=" + root, "XDG_RUNTIME_DIR=" + root, "CODEX_HOME=" + filepath.Join(root, "codex"), "CLAUDE_CONFIG_DIR=" + filepath.Join(root, "claude"), "CGX_HOME=" + filepath.Join(root, "grok")}
				for _, e := range []string{"codex", "claude", "grok"} {
					p := filepath.Join(root, e+"-absent.json")
					if e == engine && mode == "expired-default" {
						p = path
					}
					name := map[string]string{"codex": "CDX_CONFIG_PATH", "claude": "CLX_CONFIG_PATH", "grok": "CGX_CONFIG_PATH"}[e]
					env = append(env, name+"="+p)
				}
				if mode == "custom-path" {
					args = append(args, "--config", path)
				}
				args = append(args, "status")
				cmd := exec.CommandContext(ctx, binary, args...)
				cmd.Env, cmd.Dir = env, root
				out, err := cmd.CombinedOutput()
				if err != nil {
					t.Fatalf("status: %v %s", err, out)
				}
				if directControl.Load() != 0 || control.Load() == 0 {
					t.Fatalf("status bypassed communicator: direct=%d control=%d repairs=%d output=%s", directControl.Load(), control.Load(), repairs.Load(), out)
				}
				if mode == "expired-default" && repairs.Load() != 1 {
					t.Fatalf("expected exactly one verified repair, got %d", repairs.Load())
				}
			})
		}
	}
}
