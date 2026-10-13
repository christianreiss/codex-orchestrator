package communicator

import (
	"bytes"
	"context"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

// hungFixture is a real owner and real finite workers (separate processes, their
// real 15 s deadline) against an API that is unreachable in a controlled way.
type hungFixture struct {
	root, home, authPath string
	socket               string
	client               *http.Client
	job                  syncJob
	stderr               *bytes.Buffer
}

// newHungFixture starts the owner for a signed codex config pointing at base. The
// native credential is written before the owner starts, as it is on a real host
// when a session rotated it while the API was away.
func newHungFixture(t *testing.T, base string) *hungFixture {
	t.Helper()
	if testing.Short() {
		t.Skip("builds a signed real binary and waits for the 15 s worker deadline")
	}
	root := t.TempDir()
	runtimeRoot, err := os.MkdirTemp("", "cc-hung-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(runtimeRoot) })
	pub, priv, _ := ed25519.GenerateKey(cryptorand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	key := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	binary := filepath.Join(root, "cxx")
	build := exec.Command("go", "build", "-o", binary, "-ldflags", "-X github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing.buildPublicKeyB64="+key, "./cmd/cxx")
	build.Dir = "../.."
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	hostname, _ := os.Hostname()
	cfg := config.Config{SchemaVersion: 1, Engine: "codex", IssuedAt: "2026-10-13T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: base, APIKey: "fixture-host-key", InstallationID: "fixture", CommunicatorProtocol: 1, CommunicatorSyncProtocol: 1}, Host: config.Host{ID: 1, FQDN: hostname, Secure: true}, Wrapper: config.Wrapper{Version: "0.9.73", Track: "stable", BinaryURL: base + "/download", BinarySHA256: strings.Repeat("0", 64)}}
	path := filepath.Join(root, "codex.json")
	raw, _ := json.Marshal(cfg)
	_ = os.WriteFile(path, raw, 0600)
	_ = os.WriteFile(path+".sig", ed25519.Sign(priv, raw), 0600)
	f := &hungFixture{root: root, stderr: &bytes.Buffer{}}
	f.job = syncJob{Engine: "codex", Config: path, Env: map[string]string{"HOME": root}, Owner: true, Auth: true, AccountID: 1}
	f.home = jobHome(f.job)
	f.authPath = filepath.Join(f.home, "auth.json")
	f.job.AuthPath = f.authPath
	_ = os.MkdirAll(f.home, 0700)
	stamp := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	_ = os.WriteFile(f.authPath, []byte(`{"last_refresh":"`+stamp+`","tokens":{"access_token":"rotated-while-offline","refresh_token":"fixture-refresh"}}`), 0600)

	env := communicatorEnvironment(os.Environ())
	env = append(env, "HOME="+root, "XDG_RUNTIME_DIR="+runtimeRoot, "CODEX_ALLOW_FQDN_MISMATCH=1", "CDX_CONFIG_PATH="+path)
	daemon := exec.Command(binary, "communicator", "serve", "--config", path)
	daemon.Env = env
	daemon.Stderr = f.stderr
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = daemon.Process.Kill(); _ = daemon.Wait() })
	t.Setenv("XDG_RUNTIME_DIR", runtimeRoot)
	f.socket, _ = socketPath(base)
	f.client = unixClient(f.socket, 40*time.Second)
	deadline := time.Now().Add(10 * time.Second)
	for {
		res, err := f.client.Get("http://communicator.local/_comm/status")
		if err == nil {
			res.Body.Close()
			return f
		}
		if time.Now().After(deadline) {
			t.Fatalf("owner startup: %s", f.stderr.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// authSync asks the owner for one credential operation, which runs a real worker
// process under the worker's own deadline.
func (f *hungFixture) authSync(t *testing.T) (SyncResult, time.Duration) {
	t.Helper()
	raw, _ := json.Marshal(SyncRequest{Job: f.job, Operation: "auth"})
	req, _ := http.NewRequestWithContext(context.Background(), "POST", "http://communicator.local/_comm/sync", bytes.NewReader(raw))
	started := time.Now()
	res, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out SyncResult
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out, time.Since(started)
}

func (f *hungFixture) marker() string {
	raw, _ := os.ReadFile(pendingPath(f.job))
	return string(raw)
}

// An API that accepts TCP and never speaks hangs the very first dial. The worker has
// written its write-ahead marker for the rotated credential before it asks for the
// connection; if it were killed while that request still waited, the marker would
// stay and wedge every later launch ("no confirmed outcome") although nothing was
// ever sent. The wait must therefore end in a definitive "not sent" inside the
// worker's deadline, and the worker must clear its marker.
func TestHungFirstDialLetsTheAuthWorkerFinishAndClearItsMarker(t *testing.T) {
	hung, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var held []net.Conn
	var heldMu sync.Mutex
	go func() {
		for {
			c, err := hung.Accept()
			if err != nil {
				return
			}
			heldMu.Lock()
			held = append(held, c) // accepted, never read, never answered
			heldMu.Unlock()
		}
	}()
	t.Cleanup(func() {
		hung.Close()
		heldMu.Lock()
		for _, c := range held {
			c.Close()
		}
		heldMu.Unlock()
	})
	f := newHungFixture(t, "http://"+hung.Addr().String())
	before, _ := os.ReadFile(f.authPath)

	out, took := f.authSync(t)

	if took >= authWorkerTimeout {
		t.Fatalf("the worker ran %s: it was killed at its %s deadline while its request still waited", took, authWorkerTimeout)
	}
	if out.Error == nil {
		t.Fatalf("an unreachable API must be reported, got %+v", out)
	}
	var h struct {
		StatusCode int
		Code       string
	}
	if err := json.Unmarshal(out.Error.HTTP, &h); err != nil || h.StatusCode != http.StatusServiceUnavailable || h.Code != "communicator_unavailable" {
		t.Fatalf("expected a definitive 503 not-sent verdict, got %q (%s)", out.Error.HTTP, out.Error.Message)
	}
	if ambiguous(out) {
		t.Fatal("a request that was never sent was reported as an unknown outcome")
	}
	if m := f.marker(); m != "" {
		t.Fatalf("the worker left a pending marker for an upload that was never sent: %s", m)
	}
	if after, _ := os.ReadFile(f.authPath); !bytes.Equal(before, after) {
		t.Fatal("the local credential changed")
	}
	t.Logf("hung first dial: worker finished in %s with a definitive 503, no marker (worker deadline %s)", took.Round(100*time.Millisecond), authWorkerTimeout)
}

// The mirror image: once the frame was written, the worker can be killed with the
// outcome unknown. The marker must then stay, and the owner must say so.
func TestHungReplyAfterSendKeepsTheMarkerAndReportsUnknown(t *testing.T) {
	var frames atomic.Int32
	remote := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var writes sync.Mutex
		for {
			var f frame
			if websocket.JSON.Receive(ws, &f) != nil {
				return
			}
			switch f.Type {
			case "hello":
				writes.Lock()
				_ = websocket.JSON.Send(ws, frame{Type: "ready", Protocol: 1})
				writes.Unlock()
			case "heartbeat":
				writes.Lock()
				_ = websocket.JSON.Send(ws, frame{Type: "heartbeat"})
				writes.Unlock()
			case "request":
				if strings.HasPrefix(f.Path, "/auth") {
					frames.Add(1) // delivered, effect unknown: no reply, ever
					continue
				}
				writes.Lock()
				_ = websocket.JSON.Send(ws, frame{ID: f.ID, Status: 200, Body: []byte(`{"status":"ok","data":{}}`), Headers: map[string]string{"content-type": "application/json"}})
				writes.Unlock()
			}
		}
	}))
	t.Cleanup(remote.Close)
	f := newHungFixture(t, remote.URL)

	out, took := f.authSync(t)

	if frames.Load() == 0 {
		t.Fatalf("no /auth frame reached the server; the test did not exercise the after-send case (%+v)", out)
	}
	if out.Error == nil {
		t.Fatalf("a worker that lost its reply cannot report success: %+v", out)
	}
	if f.marker() == "" {
		t.Fatalf("a killed worker whose upload may have happened must keep its marker (took %s, %+v)", took, out.Error)
	}
	t.Logf("after send: %d /auth frame(s) delivered, worker ended after %s, marker kept, error %q", frames.Load(), took.Round(100*time.Millisecond), out.Error.Message)
}
