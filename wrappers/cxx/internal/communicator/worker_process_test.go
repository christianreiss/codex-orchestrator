package communicator

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"golang.org/x/net/websocket"
)

// These are the real daemon and finite worker binaries, not mocked writers.
// A fully isolated HOME prevents even a regression from touching operator state.
func TestDedicatedWorkersConvergeAllEnginesWithoutMaintenance(t *testing.T) {
	if testing.Short() {
		t.Skip("builds signed real binary")
	}
	root := t.TempDir()
	runtimeRoot, err := os.MkdirTemp("", "cc-sync-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(runtimeRoot)
	pub, priv, _ := ed25519.GenerateKey(cryptorand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	key := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	binary := filepath.Join(root, "cxx")
	build := exec.Command("go", "build", "-o", binary, "-ldflags", "-X github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing.buildPublicKeyB64="+key, "./cmd/cxx")
	build.Dir = "../.."
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	var requests atomic.Int32
	var writes sync.Mutex
	var authMu sync.Mutex
	heads := map[string]json.RawMessage{}
	stores := map[string]int{}
	var upstream *websocket.Conn
	remote := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		authMu.Lock()
		upstream = ws
		authMu.Unlock()
		send := func(f frame) { writes.Lock(); defer writes.Unlock(); _ = websocket.JSON.Send(ws, f) }
		var workers sync.WaitGroup
		defer workers.Wait()
		for {
			var f frame
			if websocket.JSON.Receive(ws, &f) != nil {
				return
			}
			switch f.Type {
			case "hello":
				send(frame{Type: "ready", Protocol: 1})
			case "heartbeat":
				send(frame{Type: "heartbeat"})
			case "request":
				workers.Add(1)
				go func(f frame) {
					defer workers.Done()
					body := []byte(`{"status":"ok","data":{}}`)
					switch strings.Split(f.Path, "?")[0] {
					case "/wrapper/v2/config":
						u, _ := url.Parse(f.Path)
						engine := u.Query().Get("engine")
						raw, err := os.ReadFile(filepath.Join(root, engine+".json"))
						if err != nil {
							t.Error(err)
							return
						}
						body, _ = json.Marshal(map[string]any{"payload": json.RawMessage(raw), "signature": map[string]string{"value": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, raw))}})
					case "/sync/bootstrap":
						requests.Add(1)
						time.Sleep(100 * time.Millisecond)
						var req struct {
							Engine      string `json:"engine"`
							IncludeAuth bool   `json:"include_auth"`
						}
						_ = json.Unmarshal(f.Body, &req)
						if req.IncludeAuth {
							t.Error("content worker read/exchanged credentials")
						}
						configText := "model = 'fixture'\n"
						if req.Engine == "claude" {
							configText = `{"model":"fixture"}`
						}
						if req.Engine == "grok" {
							configText = "[models]\ndefault='fixture'\n"
						}
						body, _ = json.Marshal(map[string]any{"status": "ok", "data": map[string]any{"status": "ok", "agents": map[string]any{"content": "# managed " + req.Engine}, "config": map[string]any{"content": configText}, "claude_skills": []any{}, "grok_skills": []any{}}})
					case "/auth":
						var req struct {
							Engine  string          `json:"engine"`
							Command string          `json:"command"`
							Auth    json.RawMessage `json:"auth"`
						}
						_ = json.Unmarshal(f.Body, &req)
						authMu.Lock()
						status := "outdated"
						if req.Command == "store" {
							heads[req.Engine] = append(json.RawMessage(nil), req.Auth...)
							stores[req.Engine]++
							status = "updated"
						}
						auth := heads[req.Engine]
						authMu.Unlock()
						body, _ = json.Marshal(map[string]any{"status": status, "engine": req.Engine, "auth": auth, "candidate_result": "accepted", "verification_state": "verified", "canonical_digest": strings.Repeat("b", 64), "canonical_last_refresh": time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), "account_id": 1, "canonical_generation": 1, "host": map[string]any{"secure": true}})
					case "/skills", "/host/users":
					default:
						t.Errorf("worker entered unrelated endpoint %s", f.Path)
					}
					send(frame{ID: f.ID, Status: 200, Body: body, Headers: map[string]string{"content-type": "application/json"}})
				}(f)
			}
		}
	}))
	defer remote.Close()
	env := communicatorEnvironment(os.Environ())
	env = append(env, "HOME="+root, "XDG_RUNTIME_DIR="+runtimeRoot, "CODEX_ALLOW_FQDN_MISMATCH=1")
	jobs := map[string]syncJob{}
	hostname, _ := os.Hostname()
	for _, engine := range []string{"codex", "claude", "grok"} {
		cfg := config.Config{SchemaVersion: 1, Engine: engine, IssuedAt: "2026-10-13T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: remote.URL, APIKey: "fixture-host-key", InstallationID: "fixture", CommunicatorProtocol: 1, CommunicatorSyncProtocol: 1}, Host: config.Host{ID: 1, FQDN: hostname, Secure: true}, Wrapper: config.Wrapper{Version: "0.9.73", Track: "stable", BinaryURL: remote.URL + "/download", BinarySHA256: strings.Repeat("0", 64)}}
		path := filepath.Join(root, engine+".json")
		raw, _ := json.Marshal(cfg)
		_ = os.WriteFile(path, raw, 0600)
		_ = os.WriteFile(path+".sig", ed25519.Sign(priv, raw), 0600)
		job := syncJob{Engine: engine, Config: path, Env: map[string]string{"HOME": root}}
		jobs[engine] = job
		env = append(env, map[string]string{"codex": "CDX_CONFIG_PATH", "claude": "CLX_CONFIG_PATH", "grok": "CGX_CONFIG_PATH"}[engine]+"="+path)
		_ = os.MkdirAll(jobHome(job), 0700)
		_ = os.WriteFile(filepath.Join(jobHome(job), "auth.json"), []byte("credential sentinel"), 0600)
	}
	daemon := exec.Command(binary, "communicator", "serve", "--config", jobs["codex"].Config)
	daemon.Env = env
	var stderr bytes.Buffer
	daemon.Stderr = &stderr
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = daemon.Process.Kill(); _ = daemon.Wait() }()
	t.Setenv("XDG_RUNTIME_DIR", runtimeRoot)
	socket, _ := socketPath(remote.URL)
	client := unixClient(socket, 10*time.Second)
	deadline := time.Now().Add(10 * time.Second)
	for {
		res, err := client.Get("http://communicator.local/_comm/status")
		if err == nil {
			res.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("daemon startup: %s", stderr.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	var wg sync.WaitGroup
	for _, engine := range []string{"codex", "claude", "grok"} {
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func(engine string) {
				defer wg.Done()
				raw, _ := json.Marshal(SyncRequest{Job: jobs[engine], Operation: "content"})
				req, _ := http.NewRequestWithContext(context.Background(), "POST", "http://communicator.local/_comm/sync", bytes.NewReader(raw))
				res, err := client.Do(req)
				if err != nil {
					t.Error(err)
					return
				}
				defer res.Body.Close()
				var out SyncResult
				if json.NewDecoder(res.Body).Decode(&out) != nil || out.Error != nil {
					t.Errorf("%s worker result: %+v", engine, out)
				}
				for _, resource := range out.Resources {
					if resource.Error != "" {
						t.Errorf("%s resource: %s", engine, resource.Error)
					}
				}
			}(engine)
		}
	}
	wg.Wait()
	if count := requests.Load(); count != 3 {
		t.Errorf("30 callers should share three content operations, got %d", count)
	}
	for _, engine := range []string{"codex", "claude", "grok"} {
		name := "AGENTS.md"
		if engine == "claude" {
			name = "CLAUDE.md"
		}
		raw, err := os.ReadFile(filepath.Join(jobHome(jobs[engine]), name))
		if err != nil || string(raw) != "# managed "+engine {
			t.Errorf("%s projection: %q %v", engine, raw, err)
		}
		auth, _ := os.ReadFile(filepath.Join(jobHome(jobs[engine]), "auth.json"))
		if string(auth) != "credential sentinel" {
			t.Errorf("content changed %s auth", engine)
		}
	}
	for _, path := range []string{".config/systemd/user", ".local/bin/codex", ".local/bin/claude", ".local/bin/grok", ".cxx/engines"} {
		if _, err := os.Stat(filepath.Join(root, path)); !os.IsNotExist(err) {
			t.Errorf("worker performed installation: %s", path)
		}
	}

	// Ten active consumers share one credential-source observer. Native writes
	// upload; an unsolicited server event downloads without another CLI launch.
	for _, engine := range []string{"codex", "claude"} {
		job := jobs[engine]
		job.Owner = true
		job.Auth = true
		job.AccountID = 1
		job.AuthPath = filepath.Join(jobHome(job), "auth.json")
		if engine == "claude" {
			job.AuthPath = filepath.Join(jobHome(job), ".credentials.json")
		}
		payload := func(token string) []byte {
			stamp := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
			if engine == "codex" {
				return []byte(fmt.Sprintf(`{"last_refresh":%q,"tokens":{"access_token":%q,"refresh_token":"fixture-refresh"}}`, stamp, token))
			}
			return []byte(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":%q,"refreshToken":"fixture-refresh"}}`, stamp, token))
		}
		_ = os.WriteFile(job.AuthPath, payload("native-first"), 0600)
		leaseCtx, cancelLeases := context.WithCancel(context.Background())
		bodies := []io.ReadCloser{}
		for i := 0; i < 10; i++ {
			job.SessionID = fmt.Sprint(i)
			raw, _ := json.Marshal([]syncJob{job})
			req, _ := http.NewRequestWithContext(leaseCtx, "POST", "http://communicator.local/_comm/lease", bytes.NewReader(raw))
			res, err := unixClient(socket, 0).Do(req)
			if err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != 200 {
				t.Fatalf("auth registration HTTP %d", res.StatusCode)
			}
			bodies = append(bodies, res.Body)
		}
		waitFor := func(label string, check func() bool) {
			t.Helper()
			deadline := time.Now().Add(12 * time.Second)
			for !check() {
				if time.Now().After(deadline) {
					raw, _ := os.ReadFile(job.AuthPath)
					pending, _ := os.ReadFile(pendingPath(job))
					res, _ := client.Get("http://communicator.local/_comm/status")
					var status []byte
					if res != nil {
						status, _ = io.ReadAll(res.Body)
						res.Body.Close()
					}
					t.Fatalf("%s: %s timeout; local=%s pending=%s status=%s", engine, label, raw, pending, status)
				}
				time.Sleep(25 * time.Millisecond)
			}
		}
		waitFor("initial upload", func() bool { authMu.Lock(); defer authMu.Unlock(); return stores[engine] >= 1 })
		// Atomic native replacement is how the CLIs commonly persist rotation.
		_ = os.WriteFile(job.AuthPath+".native-new", payload("native-rotated"), 0600)
		_ = os.Rename(job.AuthPath+".native-new", job.AuthPath)
		waitFor("native rotation upload", func() bool {
			authMu.Lock()
			defer authMu.Unlock()
			return strings.Contains(string(heads[engine]), "native-rotated")
		})
		waitFor("rotation acknowledgement", func() bool { _, err := os.Stat(pendingPath(job)); return os.IsNotExist(err) })
		// Reproduce a worker whose previous upload reply was lost. Keep its
		// digest marker while a verified, newer head arrives; the real finite
		// worker must adopt through the guarded writer and clear the marker
		// without another upstream store.
		var fence *ipc.Lock
		waitFor("reconciliation fixture fence", func() bool {
			fence, _ = ipc.TryAcquireExclusivePath(filepath.Join(filepath.Dir(socket), "sync-"+scopeID(job)+".lock"))
			return fence != nil
		})
		if err := writePending(job, fileGeneration(job.AuthPath)); err != nil {
			t.Fatal(err)
		}
		authMu.Lock()
		count := stores[engine]
		newer := payload("remote-pushed")
		var canonical map[string]any
		_ = json.Unmarshal(newer, &canonical)
		canonical["last_refresh"] = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
		heads[engine], _ = json.Marshal(canonical)
		conn := upstream
		authMu.Unlock()
		_ = fence.Release()
		writes.Lock()
		_ = websocket.JSON.Send(conn, frame{Type: "auth_changed", Engine: engine, AccountID: 1, Generation: 2})
		writes.Unlock()
		waitFor("server push adoption after unknown upload", func() bool { raw, _ := os.ReadFile(job.AuthPath); return bytes.Contains(raw, []byte("remote-pushed")) })
		waitFor("reconciled upload marker removed", func() bool { _, err := os.Stat(pendingPath(job)); return os.IsNotExist(err) })
		authMu.Lock()
		if stores[engine] != count {
			t.Errorf("%s server write echoed as upload", engine)
		}
		authMu.Unlock()
		// A valid signed rollback hands ownership back, with an explicit receipt.
		var cfg config.Config
		raw, _ := os.ReadFile(job.Config)
		_ = json.Unmarshal(raw, &cfg)
		cfg.Orchestrator.CommunicatorSyncProtocol = 0
		raw, _ = json.Marshal(cfg)
		_ = os.WriteFile(job.Config, raw, 0600)
		_ = os.WriteFile(job.Config+".sig", ed25519.Sign(priv, raw), 0600)
		reader := bufio.NewScanner(bodies[0])
		handoff := false
		for reader.Scan() {
			var status AuthStatus
			if json.Unmarshal(reader.Bytes(), &status) == nil && status.Type == "auth_handoff" {
				handoff = true
				break
			}
		}
		if !handoff {
			t.Errorf("%s rollback lost handoff receipt", engine)
		}
		cancelLeases()
		for _, body := range bodies {
			body.Close()
		}
	}
	t.Log(fmt.Sprintf("30 concurrent callers, %d engine content operations; native credentials retained", requests.Load()))
}
