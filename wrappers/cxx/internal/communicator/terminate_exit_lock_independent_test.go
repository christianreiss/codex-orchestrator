package communicator

import (
	"bufio"
	"bytes"
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
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"golang.org/x/net/websocket"
)

// A real owner process, announced control, and a real exit: the server asks, the
// owner acknowledges with its own pid, the process goes away, and a surviving
// client starts a replacement that describes itself with a different pid. Only
// this fixture pauses/resumes its clients; owner termination never signals them.
func TestIndependentRemoteTerminateExitLockAndSurvivingClients(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the real multicall binary")
	}
	root := t.TempDir()
	runtimeRoot, err := os.MkdirTemp("", "cc-term-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(runtimeRoot) })
	pub, priv, err := ed25519.GenerateKey(cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	key := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	binary := filepath.Join(root, "cxx")
	build := exec.Command("go", "build", "-o", binary, "-ldflags", "-X github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing.buildPublicKeyB64="+key, "./cmd/cxx")
	build.Dir = "../.."
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}

	type owner struct {
		ws  *websocket.Conn
		pid int
	}
	var mu sync.Mutex
	var current *owner
	describes := make(chan int, 4)
	acks := make(chan map[string]any, 4)
	remote := websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		me := &owner{ws: ws}
		for {
			var f map[string]any
			if websocket.JSON.Receive(ws, &f) != nil {
				return
			}
			switch f["type"] {
			case "hello":
				// The server announces that it may ask this owner to stop.
				websocket.JSON.Send(ws, map[string]any{"type": "ready", "protocol": 1, "control": []string{"terminate"}})
			case "heartbeat":
				websocket.JSON.Send(ws, map[string]any{"type": "heartbeat"})
			case "capabilities":
				pid, _ := f["pid"].(float64)
				if f["terminate"] != true || f["started_at"] == "" {
					t.Errorf("incomplete capabilities frame: %v", f)
				}
				me.pid = int(pid)
				mu.Lock()
				current = me
				mu.Unlock()
				describes <- me.pid
			case "terminate_ack":
				acks <- f
			case "request":
				var req struct {
					ID json.RawMessage `json:"id"`
				}
				raw, _ := base64.StdEncoding.DecodeString(fmt.Sprint(f["body"]))
				json.Unmarshal(raw, &req)
				body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"ok": true}})
				websocket.JSON.Send(ws, frame{ID: fmt.Sprint(f["id"]), Status: 200, Body: body, Headers: map[string]string{"content-type": "application/json"}})
			}
		}
	})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/mcp" {
			io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`)
			return
		}
		remote.ServeHTTP(w, r)
	}))
	defer upstream.Close()

	env := append(os.Environ(), "XDG_RUNTIME_DIR="+runtimeRoot, "CXX_MCP_BEARER=fixture")
	cfg := config.Config{SchemaVersion: 1, Engine: "codex", IssuedAt: "2026-10-13T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "fixture-host-key", InstallationID: "fixture", CommunicatorProtocol: 1}, Host: config.Host{ID: 1, FQDN: "fixture.example", Secure: true}, Wrapper: config.Wrapper{Version: "0.9.71", Track: "stable", BinaryURL: upstream.URL + "/download", BinarySHA256: strings.Repeat("0", 64)}}
	path := filepath.Join(root, "codex.json")
	raw, _ := json.Marshal(cfg)
	os.WriteFile(path, raw, 0600)
	os.WriteFile(path+".sig", ed25519.Sign(priv, raw), 0600)
	env = append(env, "CDX_CONFIG_PATH="+path)

	t.Setenv("XDG_RUNTIME_DIR", runtimeRoot)
	socket, err := socketPath(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	status := func() map[string]any {
		res, err := unixClient(socket, time.Second).Get("http://communicator.local/_comm/status")
		if err != nil {
			return nil
		}
		defer res.Body.Close()
		var s map[string]any
		json.NewDecoder(res.Body).Decode(&s)
		return s
	}
	var clients []*exec.Cmd
	var inputs []io.WriteCloser
	var outputs []*bufio.Reader
	for i := 0; i < 2; i++ {
		cmd := exec.Command(binary, "communicator", "mcp", "codex")
		cmd.Env = env
		in, _ := cmd.StdinPipe()
		out, _ := cmd.StdoutPipe()
		cmd.Stderr = &bytes.Buffer{}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		clients, inputs, outputs = append(clients, cmd), append(inputs, in), append(outputs, bufio.NewReader(out))
	}
	defer func() {
		for i, c := range clients {
			_ = syscall.Kill(c.Process.Pid, syscall.SIGCONT)
			inputs[i].Close()
			c.Wait()
		}
		if s := status(); s != nil {
			if pid, ok := s["pid"].(float64); ok {
				if p, err := os.FindProcess(int(pid)); err == nil {
					p.Kill()
				}
			}
		}
	}()
	call := func(i, id int) {
		t.Helper()
		fmt.Fprintf(inputs[i], "{\"jsonrpc\":\"2.0\",\"id\":%d,\"method\":\"tools/list\"}\n", id)
		done := make(chan string, 1)
		go func() { line, _ := outputs[i].ReadString('\n'); done <- line }()
		select {
		case line := <-done:
			if !strings.Contains(line, `"result"`) {
				t.Fatalf("client %d got %s", i, line)
			}
		case <-time.After(25 * time.Second):
			t.Fatalf("client %d timed out", i)
		}
	}
	call(0, 1)
	call(1, 2)

	var first int
	select {
	case first = <-describes:
	case <-time.After(10 * time.Second):
		t.Fatal("the owner never described itself to a server that announced control")
	}
	if got, _ := status()["pid"].(float64); int(got) != first {
		t.Fatalf("capabilities pid %d is not the owner's own pid %v", first, got)
	}

	// Pause ONLY this test's known client PIDs, so auto-recovery cannot
	// acquire the owner lock before we probe its release. They remain alive.
	for _, client := range clients {
		if err := syscall.Kill(client.Process.Pid, syscall.SIGSTOP); err != nil {
			t.Fatal(err)
		}
	}
	startExit := time.Now()
	// The server asks it to stop.
	mu.Lock()
	target := current
	mu.Unlock()
	if err := websocket.JSON.Send(target.ws, frame{Type: "terminate", RequestID: "t-1", Reason: "admin"}); err != nil {
		t.Fatal(err)
	}
	select {
	case ack := <-acks:
		if ack["request_id"] != "t-1" || ack["accepted"] != true || int(ack["pid"].(float64)) != first {
			t.Fatalf("unexpected acknowledgement: %v", ack)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no acknowledgement from the owner")
	}
	deadline := startExit.Add(3500 * time.Millisecond)
	for processAlive(first) {
		if time.Now().After(deadline) {
			t.Fatalf("owner %d acknowledged and then kept running", first)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if time.Since(startExit) > 3500*time.Millisecond {
		t.Fatal("owner exit/ACK observation exceeded the bounded stop window")
	}

	t.Logf("real owner PID=%d stopped after %s; socket=%s", first, time.Since(startExit), socket)
	// Direct proof, not socket inference: the exact owner.lock is available
	// after process death, and the old Unix socket has been removed.
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(filepath.Dir(socket), "owner.lock"))
	if err != nil {
		t.Fatalf("owner process exited but owner.lock unavailable: %v", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Fatalf("old socket retained after process exit: %v", err)
	}
	t.Log("exact owner.lock acquired/released; old socket absent")
	for _, client := range clients {
		if err := syscall.Kill(client.Process.Pid, syscall.SIGCONT); err != nil {
			t.Fatal(err)
		}
	}
	// Surviving clients start a replacement, which says it is a different process.
	var second int
	select {
	case second = <-describes:
	case <-time.After(30 * time.Second):
		t.Fatal("no replacement owner after the stop")
	}
	if second == first {
		t.Fatalf("replacement reused pid %d", first)
	}
	t.Logf("replacement PID=%d acquired the same socket/lock; first PID=%d", second, first)
	call(0, 3)
	call(1, 4)
	for i, c := range clients {
		t.Logf("surviving MCP client %d PID=%d", i, c.Process.Pid)
		if !processAlive(c.Process.Pid) {
			t.Fatalf("client %d did not survive the owner's stop", i)
		}
	}
}
