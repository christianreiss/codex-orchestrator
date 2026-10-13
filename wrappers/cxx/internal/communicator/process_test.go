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
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

// Real processes, signed configurations and sockets exercise the first-start
// race, all three MCP entrypoints, lost transport and a crashed local owner.
func TestProcessesShareConnectionAndRecover(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the real multicall binary")
	}
	root := t.TempDir()
	runtimeRoot, err := os.MkdirTemp("", "cc-test-")
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
	var connected atomic.Int32
	var total atomic.Int32
	var peak atomic.Int32
	var ambiguousWrites atomic.Int32
	var activeMu sync.Mutex
	var active *websocket.Conn
	var directMCP atomic.Int32
	remoteSocket := websocket.Handler(func(ws *websocket.Conn) {
		count := connected.Add(1)
		defer connected.Add(-1)
		total.Add(1)
		for old := peak.Load(); count > old; old = peak.Load() {
			if peak.CompareAndSwap(old, count) {
				break
			}
		}
		activeMu.Lock()
		active = ws
		activeMu.Unlock()
		defer ws.Close()
		for {
			var f frame
			if websocket.JSON.Receive(ws, &f) != nil {
				return
			}
			switch f.Type {
			case "hello":
				websocket.JSON.Send(ws, frame{Type: "ready", Protocol: 1})
			case "heartbeat":
				websocket.JSON.Send(ws, frame{Type: "heartbeat"})
			case "request":
				var req struct {
					ID     json.RawMessage `json:"id"`
					Method string          `json:"method"`
				}
				json.Unmarshal(f.Body, &req)
				body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"engine": f.Headers["x-engine"]}})
				status := 200
				if req.Method == "tools/call" {
					ambiguousWrites.Add(1)
					status = 409
					body = []byte(`{"error":{"code":"communicator_outcome_unknown","message":"private upstream detail"}}`)
				}
				if err := websocket.JSON.Send(ws, frame{ID: f.ID, Status: status, Body: body, Headers: map[string]string{"content-type": "application/json"}}); err != nil {
					return
				}
			}
		}
	})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/mcp" {
			directMCP.Add(1)
			io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"engine":"codex"}}`)
			return
		}
		if r.URL.Path == "/wrapper/v2/download" {
			io.WriteString(w, r.Header.Get("X-API-Key"))
			return
		}
		remoteSocket.ServeHTTP(w, r)
	}))
	defer upstream.Close()
	env := append(os.Environ(), "XDG_RUNTIME_DIR="+runtimeRoot, "CXX_MCP_BEARER=fixture")
	configs := map[string]config.Config{}
	for _, engine := range []string{"codex", "claude", "grok"} {
		cfg := config.Config{SchemaVersion: 1, Engine: engine, IssuedAt: "2026-10-13T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "fixture-host-key", InstallationID: "fixture", CommunicatorProtocol: 1}, Host: config.Host{ID: 1, FQDN: "fixture.example", Secure: true}, Wrapper: config.Wrapper{Version: "0.9.71", Track: "stable", BinaryURL: upstream.URL + "/download", BinarySHA256: strings.Repeat("0", 64)}}
		path := filepath.Join(root, engine+".json")
		raw, _ := json.Marshal(cfg)
		os.WriteFile(path, raw, 0600)
		os.WriteFile(path+".sig", ed25519.Sign(priv, raw), 0600)
		configs[path] = cfg
		if _, err := loadSigned(path, pub); err != nil {
			t.Fatalf("%s first start: %v", engine, err)
		}
		name := map[string]string{"codex": "CDX_CONFIG_PATH", "claude": "CLX_CONFIG_PATH", "grok": "CGX_CONFIG_PATH"}[engine]
		env = append(env, name+"="+path)
	}
	// An unsafe local runtime directory is a transport failure, never a signed
	// instruction to send managed traffic directly to HTTPS.
	unsafeRuntime := t.TempDir()
	if err := os.Chmod(unsafeRuntime, 0755); err != nil {
		t.Fatal(err)
	}
	blocked := exec.Command(binary, "communicator", "mcp", "codex")
	blocked.Env = append(append([]string{}, env...), "XDG_RUNTIME_DIR="+unsafeRuntime)
	blocked.Stdin = strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n")
	result, err := blocked.Output()
	if err != nil || !bytes.Contains(result, []byte(`"error"`)) || directMCP.Load() != 0 {
		t.Fatalf("unsafe runtime downgraded transport: calls=%d, result=%s, err=%v", directMCP.Load(), result, err)
	}
	type child struct {
		cmd    *exec.Cmd
		in     io.WriteCloser
		out    *bufio.Reader
		engine string
		stderr *bytes.Buffer
	}
	children := []child{}
	t.Setenv("XDG_RUNTIME_DIR", runtimeRoot)
	socket, err := socketPath(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	readStatus := func() map[string]any {
		res, err := unixClient(socket, time.Second).Get("http://communicator.local/_comm/status")
		if err != nil {
			return nil
		}
		defer res.Body.Close()
		var status map[string]any
		json.NewDecoder(res.Body).Decode(&status)
		return status
	}
	cleanupOwner := func() {
		status := readStatus()
		if pid, ok := status["pid"].(float64); ok {
			p, _ := os.FindProcess(int(pid))
			p.Kill()
		}
	}
	defer func() {
		for _, c := range children {
			c.in.Close()
			c.cmd.Wait()
		}
		cleanupOwner()
	}()
	for i := 0; i < 6; i++ {
		engine := []string{"grok", "claude", "codex"}[i%3]
		cmd := exec.Command(binary, "communicator", "mcp", engine)
		cmd.Env = env
		in, _ := cmd.StdinPipe()
		out, _ := cmd.StdoutPipe()
		stderr := &bytes.Buffer{}
		cmd.Stderr = stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		children = append(children, child{cmd, in, bufio.NewReader(out), engine, stderr})
	}
	request := func(c child, id int) {
		t.Helper()
		fmt.Fprintf(c.in, "{\"jsonrpc\":\"2.0\",\"id\":%d,\"method\":\"tools/list\"}\n", id)
		done := make(chan string, 1)
		go func() {
			line, err := c.out.ReadString('\n')
			if err != nil {
				done <- "read failed: " + err.Error()
				return
			}
			done <- line
		}()
		select {
		case line := <-done:
			var res struct {
				Result struct {
					Engine string `json:"engine"`
				} `json:"result"`
			}
			if json.Unmarshal([]byte(line), &res) != nil || res.Result.Engine != c.engine {
				t.Errorf("%s: %s", c.engine, line)
			}
		case <-time.After(25 * time.Second):
			t.Fatalf("%s MCP timeout", c.engine)
		}
	}
	// All clients ask before the first communicator owns the socket.
	var wg sync.WaitGroup
	for i, c := range children {
		wg.Add(1)
		go func(c child, id int) { defer wg.Done(); request(c, id) }(c, i)
	}
	wg.Wait()
	if total.Load() != 1 || peak.Load() != 1 {
		t.Fatalf("initial connections total=%d peak=%d", total.Load(), peak.Load())
	}
	// Rotate signed transport credentials while every MCP process stays alive.
	// The reconnected owner's independent HTTPS path must adopt the same head.
	for path, cfg := range configs {
		cfg.Orchestrator.APIKey = "rotated-host-key"
		raw, _ := json.Marshal(cfg)
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path+".sig", ed25519.Sign(priv, raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	activeMu.Lock()
	active.Close()
	activeMu.Unlock()
	deadlineReconnect := time.Now().Add(20 * time.Second)
	for total.Load() < 2 {
		if time.Now().After(deadlineReconnect) {
			t.Fatal("server reconnect timed out")
		}
		time.Sleep(50 * time.Millisecond)
	}
	request(children[0], 20)
	res, err := unixClient(socket, 5*time.Second).Get("http://communicator.local/wrapper/v2/download")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || string(body) != "rotated-host-key" {
		t.Fatalf("HTTPS transfer did not adopt signed rotation: %q, %v", body, err)
	}
	// Downloads continue while reconnect selects a different engine's policy.
	stopDownloads := make(chan struct{})
	var downloads sync.WaitGroup
	for i := 0; i < 3; i++ {
		downloads.Add(1)
		go func() {
			defer downloads.Done()
			for {
				select {
				case <-stopDownloads:
					return
				default:
				}
				res, err := unixClient(socket, 5*time.Second).Get("http://communicator.local/wrapper/v2/download")
				if err != nil {
					t.Error(err)
					return
				}
				body, err := io.ReadAll(res.Body)
				res.Body.Close()
				if err != nil || string(body) != "rotated-host-key" {
					t.Errorf("concurrent transfer adopted wrong policy: %q, %v", body, err)
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
		}()
	}
	var stopDownloadsOnce sync.Once
	finishDownloads := func() {
		stopDownloadsOnce.Do(func() { close(stopDownloads) })
		downloads.Wait()
	}
	defer finishDownloads()
	// Disable the original Codex transport config while other engines stay on.
	codexPath := filepath.Join(root, "codex.json")
	disabled := configs[codexPath]
	disabled.Orchestrator.CommunicatorProtocol = 0
	disabled.Orchestrator.APIKey = "disabled-engine-key"
	rawDisabled, _ := json.Marshal(disabled)
	if err := os.WriteFile(codexPath, rawDisabled, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codexPath+".sig", ed25519.Sign(priv, rawDisabled), 0600); err != nil {
		t.Fatal(err)
	}
	activeMu.Lock()
	active.Close()
	activeMu.Unlock()
	deadlineReconnect = time.Now().Add(10 * time.Second)
	for total.Load() < 3 {
		if time.Now().After(deadlineReconnect) {
			t.Fatal("surviving engines did not reconnect after Codex transport disable")
		}
		time.Sleep(50 * time.Millisecond)
	}
	request(children[0], 21)
	res, err = unixClient(socket, 5*time.Second).Get("http://communicator.local/wrapper/v2/download")
	if err != nil {
		t.Fatal(err)
	}
	body, err = io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || string(body) != "rotated-host-key" {
		t.Fatalf("disabled seed still controls HTTPS transfers: %q, %v", body, err)
	}
	// Claude is now the selected config. Removing it must leave Grok able to
	// reconnect, and surviving clients must also replace an owner after a crash.
	seedPath := filepath.Join(root, "claude.json")
	if err := os.Remove(seedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(seedPath + ".sig"); err != nil {
		t.Fatal(err)
	}
	activeMu.Lock()
	active.Close()
	activeMu.Unlock()
	deadlineReconnect = time.Now().Add(10 * time.Second)
	for total.Load() < 4 {
		if time.Now().After(deadlineReconnect) {
			t.Fatal("surviving engines did not reconnect after Claude seed removal")
		}
		time.Sleep(50 * time.Millisecond)
	}
	request(children[0], 22)
	finishDownloads()
	// Killing only this test's owner must leave every native/MCP client alive.
	previous := readStatus()["pid"]
	cleanupOwner()
	deadline := time.Now().Add(20 * time.Second)
	for {
		status := readStatus()
		if status["pid"] != nil && status["pid"] != previous && status["connected"] == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("communicator not restarted by surviving clients")
		}
		time.Sleep(50 * time.Millisecond)
	}
	for i, c := range children {
		request(c, 30+i)
	}
	// Each native engine must see that a potentially committed tool call cannot
	// safely be repeated, and the adapter must never retry it itself.
	for i, c := range children {
		id := 100 + i
		fmt.Fprintf(c.in, "{\"jsonrpc\":\"2.0\",\"id\":%d,\"method\":\"tools/call\"}\n", id)
		line, err := c.out.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		var reply struct {
			ID    int
			Error struct {
				Message string
				Data    struct {
					Code    string
					Unknown bool `json:"outcome_unknown"`
				}
			}
		}
		if json.Unmarshal([]byte(line), &reply) != nil || reply.ID != id || reply.Error.Data.Code != "communicator_outcome_unknown" || !reply.Error.Data.Unknown || !strings.Contains(reply.Error.Message, "before retrying") || strings.Contains(line, "private upstream") {
			t.Errorf("%s lost unknown outcome: %s", c.engine, line)
		}
	}
	if ambiguousWrites.Load() != int32(len(children)) {
		t.Fatalf("ambiguous calls replayed: %d", ambiguousWrites.Load())
	}
	t.Logf("six clients, three engines: initial connections=1, after reconnect/crash=%d", total.Load())
}
