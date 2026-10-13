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
	"golang.org/x/net/websocket"
)

// processAlive is false for a process that is gone or only a zombie awaiting its
// parent: neither can serve anything.
func processAlive(pid int) bool {
	if err := syscall.Kill(pid, 0); err != nil {
		return false
	}
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	fields := strings.Fields(string(stat[strings.LastIndexByte(string(stat), ')')+1:]))
	return len(fields) == 0 || fields[0] != "Z"
}

// A real owner process, announced control, and a real exit: the server asks, the
// owner acknowledges with its own pid, the process goes away, and a surviving
// client starts a replacement that describes itself with a different pid. Nothing
// here signals the clients.
func TestRemoteTerminateStopsTheRealOwnerAndClientsRestartIt(t *testing.T) {
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
	type identity struct {
		pid        int
		instanceID string
		runtimeID  string
	}
	describes := make(chan identity, 4)
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
				websocket.JSON.Send(ws, map[string]any{"type": "ready", "protocol": 1, "control": []string{"terminate", "identity"}})
			case "heartbeat":
				websocket.JSON.Send(ws, map[string]any{"type": "heartbeat"})
			case "capabilities":
				pid, _ := f["pid"].(float64)
				if f["terminate"] != true || f["started_at"] == "" {
					t.Errorf("incomplete capabilities frame: %v", f)
				}
				me.pid = int(pid)
				instance, _ := f["instance_id"].(string)
				runtime, _ := f["runtime_id"].(string)
				if len(instance) != 36 || len(runtime) != 16 {
					t.Errorf("capabilities carry no usable owner identity: %v", f)
				}
				mu.Lock()
				current = me
				mu.Unlock()
				describes <- identity{pid: me.pid, instanceID: instance, runtimeID: runtime}
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

	var firstIdentity identity
	select {
	case firstIdentity = <-describes:
	case <-time.After(10 * time.Second):
		t.Fatal("the owner never described itself to a server that announced control")
	}
	first := firstIdentity.pid
	if got, _ := status()["pid"].(float64); int(got) != first {
		t.Fatalf("capabilities pid %d is not the owner's own pid %v", first, got)
	}

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
	deadline := time.Now().Add(15 * time.Second)
	for processAlive(first) {
		if time.Now().After(deadline) {
			t.Fatalf("owner %d acknowledged and then kept running", first)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Surviving clients start a replacement, which says it is a different process.
	var secondIdentity identity
	select {
	case secondIdentity = <-describes:
	case <-time.After(30 * time.Second):
		t.Fatal("no replacement owner after the stop")
	}
	second := secondIdentity.pid
	if second == first {
		t.Fatalf("replacement reused pid %d", first)
	}
	// A different process, in the same runtime namespace: that pairing is what lets
	// the server call it the replacement rather than a coincidence.
	if secondIdentity.instanceID == firstIdentity.instanceID {
		t.Fatal("a new process reused the old instance id")
	}
	if secondIdentity.runtimeID != firstIdentity.runtimeID {
		t.Fatalf("replacement serves another runtime namespace: %s != %s", secondIdentity.runtimeID, firstIdentity.runtimeID)
	}
	call(0, 3)
	call(1, 4)
	for i, c := range clients {
		if !processAlive(c.Process.Pid) {
			t.Fatalf("client %d did not survive the owner's stop", i)
		}
	}
}
