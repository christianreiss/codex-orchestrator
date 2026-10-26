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
	"syscall"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

// mcpFixture runs the real multicall binary against a fake orchestrator whose
// /mcp dispatch mirrors api/src/services/mcp-server.ts: an array yields an
// array of per-item replies with notifications omitted, and an empty result
// is a 202 without a body. Methods script malformed or slow upstream replies.
type mcpFixture struct {
	t          *testing.T
	binary     string
	env        []string
	socket     string
	release    chan struct{}
	unblock    func()
	dispatched atomic.Int32
	stderr     []*bytes.Buffer
}

func newMCPFixture(t *testing.T) *mcpFixture {
	t.Helper()
	if testing.Short() {
		t.Skip("builds the real multicall binary")
	}
	root := t.TempDir()
	// Short 0700 runtime root: a long t.TempDir path can exceed sun_path.
	runtimeRoot, err := os.MkdirTemp("", "cc-mcp-")
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
	f := &mcpFixture{t: t, binary: binary, release: make(chan struct{})}
	var releaseOnce sync.Once
	f.unblock = func() { releaseOnce.Do(func() { close(f.release) }) }
	t.Cleanup(f.unblock)
	remote := websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var sendMu sync.Mutex
		for {
			var fr frame
			if websocket.JSON.Receive(ws, &fr) != nil {
				return
			}
			switch fr.Type {
			case "hello":
				sendMu.Lock()
				websocket.JSON.Send(ws, frame{Type: "ready", Protocol: 1})
				sendMu.Unlock()
			case "heartbeat":
				sendMu.Lock()
				websocket.JSON.Send(ws, frame{Type: "heartbeat"})
				sendMu.Unlock()
			case "request":
				go func(fr frame) {
					status, body := f.dispatch(fr.Body)
					sendMu.Lock()
					defer sendMu.Unlock()
					websocket.JSON.Send(ws, frame{ID: fr.ID, Status: status, Body: body, Headers: map[string]string{"content-type": "application/json"}})
				}(fr)
			}
		}
	})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/mcp" {
			t.Errorf("MCP bypassed the communicator")
			http.Error(w, "direct", 500)
			return
		}
		remote.ServeHTTP(w, r)
	}))
	t.Cleanup(upstream.Close)
	f.env = append(communicatorEnvironment(os.Environ()), "XDG_RUNTIME_DIR="+runtimeRoot, "CXX_MCP_BEARER=fixture")
	for _, engine := range []string{"codex", "claude", "grok"} {
		cfg := config.Config{SchemaVersion: 1, Engine: engine, IssuedAt: "2026-10-13T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "fixture-host-key", InstallationID: "fixture", CommunicatorProtocol: 1}, Host: config.Host{ID: 1, FQDN: "fixture.example", Secure: true}, Wrapper: config.Wrapper{Version: "0.9.76", Track: "stable", BinaryURL: upstream.URL + "/download", BinarySHA256: strings.Repeat("0", 64)}}
		path := filepath.Join(root, engine+".json")
		raw, _ := json.Marshal(cfg)
		os.WriteFile(path, raw, 0600)
		os.WriteFile(path+".sig", ed25519.Sign(priv, raw), 0600)
		name := map[string]string{"codex": "CDX_CONFIG_PATH", "claude": "CLX_CONFIG_PATH", "grok": "CGX_CONFIG_PATH"}[engine]
		f.env = append(f.env, name+"="+path)
	}
	t.Setenv("XDG_RUNTIME_DIR", runtimeRoot)
	if f.socket, err = socketPath(upstream.URL); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if pid, ok := f.status()["pid"].(float64); ok {
			if p, err := os.FindProcess(int(pid)); err == nil {
				p.Kill()
			}
		}
		if t.Failed() {
			for i, b := range f.stderr {
				t.Logf("adapter %d stderr: %s", i, b.String())
			}
		}
	})
	return f
}

func (f *mcpFixture) dispatch(body []byte) (int, []byte) {
	f.dispatched.Add(1)
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var items []json.RawMessage
		if json.Unmarshal(trimmed, &items) != nil {
			return 200, []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`)
		}
		replies := []json.RawMessage{}
		for _, item := range items {
			if reply := f.one(item); reply != nil {
				replies = append(replies, reply)
			}
		}
		if len(replies) == 0 {
			return 202, nil
		}
		raw, _ := json.Marshal(replies)
		return 200, raw
	}
	reply := f.one(trimmed)
	if reply == nil {
		return 202, nil
	}
	return 200, reply
}

func (f *mcpFixture) one(raw []byte) json.RawMessage {
	var req struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  *string         `json:"method"`
	}
	if json.Unmarshal(raw, &req) != nil || !bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{")) {
		return json.RawMessage(`{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}`)
	}
	// mcp-server.ts handleOne: a bad envelope is answered with raw.id ?? null.
	if req.JSONRPC != "2.0" || req.Method == nil {
		id := "null"
		if len(req.ID) > 0 {
			id = string(req.ID)
		}
		return json.RawMessage(`{"jsonrpc":"2.0","id":` + id + `,"error":{"code":-32600,"message":"Invalid Request"}}`)
	}
	if len(req.ID) == 0 || string(req.ID) == "null" {
		return nil
	}
	id := string(req.ID)
	method := *req.Method
	switch method {
	case "bad-error":
		return json.RawMessage(`{"jsonrpc":"2.0","id":` + id + `,"error":null}`)
	case "slow":
		<-f.release
	case "drop":
		// A server fault that loses one member's reply after dispatch.
		return nil
	case "big":
		return json.RawMessage(`{"jsonrpc":"2.0","id":` + id + `,"result":{"pad":"` + strings.Repeat("x", 256*1024) + `"}}`)
	}
	return json.RawMessage(`{"jsonrpc":"2.0","id":` + id + `,"result":{"method":"` + method + `"}}`)
}

func (f *mcpFixture) status() map[string]any {
	res, err := unixClient(f.socket, time.Second).Get("http://communicator.local/_comm/status")
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	var status map[string]any
	json.NewDecoder(res.Body).Decode(&status)
	return status
}

type mcpChild struct {
	cmd   *exec.Cmd
	in    io.WriteCloser
	lines chan string
	done  chan error
}

func (f *mcpFixture) start(engine string) *mcpChild {
	f.t.Helper()
	cmd := exec.Command(f.binary, "communicator", "mcp", engine)
	cmd.Env = f.env
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	stderr := &bytes.Buffer{}
	f.stderr = append(f.stderr, stderr)
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		f.t.Fatal(err)
	}
	c := &mcpChild{cmd: cmd, in: in, lines: make(chan string, 64), done: make(chan error, 1)}
	go func() {
		reader := bufio.NewReader(out)
		for {
			line, err := reader.ReadString('\n')
			if line != "" {
				c.lines <- line
			}
			if err != nil {
				close(c.lines)
				c.done <- cmd.Wait()
				return
			}
		}
	}()
	f.t.Cleanup(func() {
		in.Close()
		select {
		case <-c.done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
		}
	})
	return c
}

func (c *mcpChild) send(line string) { fmt.Fprintln(c.in, line) }

func TestMCPFixtureIgnoresInheritedNativeBroker(t *testing.T) {
	// A managed test runner has a real broker capability. Substitute an invalid
	// one so a regression cannot contact the runner's live session.
	t.Setenv("CXX_AGENT_PORTAL_SOCKET", filepath.Join(t.TempDir(), "foreign-broker.sock"))
	t.Setenv("CXX_AGENT_BEARER", "foreign-fixture-capability")
	f := newMCPFixture(t)
	for _, engine := range []string{"codex", "claude", "grok"} {
		c := f.start(engine)
		c.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
		line, ok := c.next(t, 15*time.Second)
		var reply struct {
			Result struct{ Method string }
		}
		if !ok || json.Unmarshal([]byte(line), &reply) != nil || reply.Result.Method != "tools/list" {
			t.Fatalf("%s did not reach its isolated MCP fixture: %s", engine, line)
		}
	}
}

func TestMCPAdapterPreservesLargeNumericReplyIDs(t *testing.T) {
	f := newMCPFixture(t)
	ids := []string{"9007199254740993", "9223372036854775807"}
	for _, engine := range []string{"codex", "claude", "grok"} {
		c := f.start(engine)
		for _, id := range ids {
			c.send(`{"jsonrpc":"2.0","id":` + id + `,"method":"tools/list"}`)
			line, ok := c.next(t, 15*time.Second)
			var reply struct{ ID json.RawMessage }
			if !ok || json.Unmarshal([]byte(line), &reply) != nil || string(reply.ID) != id {
				t.Fatalf("%s rounded numeric reply ID %s: %s", engine, id, line)
			}
		}
		c.send(`[{"jsonrpc":"2.0","id":` + ids[0] + `,"method":"tools/list"},{"jsonrpc":"2.0","id":` + ids[1] + `,"method":"tools/list"}]`)
		line, ok := c.next(t, 15*time.Second)
		var replies []struct{ ID json.RawMessage }
		if !ok || json.Unmarshal([]byte(line), &replies) != nil || len(replies) != len(ids) {
			t.Fatalf("%s invalid batch reply: %s", engine, line)
		}
		for i, reply := range replies {
			if string(reply.ID) != ids[i] {
				t.Fatalf("%s rounded batch ID %s: %s", engine, ids[i], line)
			}
		}
	}
}

func (c *mcpChild) next(t *testing.T, within time.Duration) (string, bool) {
	t.Helper()
	select {
	case line, ok := <-c.lines:
		return line, ok
	case <-time.After(within):
		return "", false
	}
}

// exited reports whether the process ended by itself within the deadline. A
// hung process is killed so the red case fails instead of hanging go test.
func (c *mcpChild) exited(within time.Duration) (bool, *os.ProcessState) {
	select {
	case <-c.done:
		return true, c.cmd.ProcessState
	case <-time.After(within):
		c.cmd.Process.Kill()
		return false, nil
	}
}

func (f *mcpFixture) waitSessions(want float64, within time.Duration) (float64, bool) {
	deadline := time.Now().Add(within)
	var got float64 = -1
	for time.Now().Before(deadline) {
		if v, ok := f.status()["sessions"].(float64); ok {
			got = v
			if v == want {
				return v, true
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return got, false
}

// SIGTERM must end an adapter whose native client still holds stdin open, and
// release its owner lease, for every engine.
func TestMCPAdapterSIGTERMWithHeldStdin(t *testing.T) {
	f := newMCPFixture(t)
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			c := f.start(engine)
			// A completed exchange proves NotifyContext is installed and starts
			// the lease; an earlier SIGTERM would just kill the process.
			c.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
			if line, ok := c.next(t, 25*time.Second); !ok || !strings.Contains(line, `"tools/list"`) {
				t.Fatalf("warm-up reply: %q", line)
			}
			if got, ok := f.waitSessions(1, 10*time.Second); !ok {
				t.Fatalf("lease not held before signal: sessions=%v", got)
			}
			c.cmd.Process.Signal(syscall.SIGTERM)
			start := time.Now()
			// Lease release and process exit are separate findings.
			sessions, released := f.waitSessions(0, 5*time.Second)
			ok, state := c.exited(5 * time.Second)
			t.Logf("%s: lease released=%v (sessions=%v), exited=%v after %s", engine, released, sessions, ok, time.Since(start).Round(time.Millisecond))
			if !released {
				t.Errorf("owner lease still held %s after SIGTERM: sessions=%v", time.Since(start).Round(time.Millisecond), sessions)
			}
			if !ok {
				t.Errorf("adapter did not exit within 5s of SIGTERM while stdin stayed open")
			} else if !state.Exited() {
				t.Errorf("adapter died by signal instead of handling SIGTERM: %v", state)
			}
		})
	}
}

// SIGTERM during an in-flight request must still report that request's
// outcome as unknown before exiting; a bare os.Exit would drop it.
func TestMCPAdapterSIGTERMReportsInflightOutcome(t *testing.T) {
	f := newMCPFixture(t)
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			c := f.start(engine)
			c.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
			if line, ok := c.next(t, 25*time.Second); !ok || !strings.Contains(line, `"tools/list"`) {
				t.Fatalf("warm-up reply: %q", line)
			}
			c.send(`{"jsonrpc":"2.0","id":"inflight","method":"slow"}`)
			time.Sleep(500 * time.Millisecond)
			c.cmd.Process.Signal(syscall.SIGTERM)
			line, got := c.next(t, 5*time.Second)
			var reply struct {
				ID    string
				Error struct {
					Data struct {
						Code    string
						Unknown bool `json:"outcome_unknown"`
					}
				}
			}
			if !got || json.Unmarshal([]byte(line), &reply) != nil || reply.ID != "inflight" || !reply.Error.Data.Unknown {
				t.Errorf("in-flight outcome not reported as unknown: %q", line)
			}
			if ok, _ := c.exited(5 * time.Second); !ok {
				t.Errorf("adapter did not exit within 5s of SIGTERM with an in-flight request")
			}
		})
	}
}

// The API advertises protocol 2025-03-26 and dispatches JSON-RPC arrays, so
// the stdio adapter must forward batches and return the array reply.
func TestMCPAdapterBatchParity(t *testing.T) {
	f := newMCPFixture(t)
	decode := func(t *testing.T, line string) []map[string]any {
		var replies []map[string]any
		if err := json.Unmarshal([]byte(line), &replies); err != nil {
			t.Errorf("batch reply is not an array: %q", line)
		}
		return replies
	}
	alive := func(t *testing.T, c *mcpChild, id int) {
		t.Helper()
		c.send(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"ping"}`, id))
		line, ok := c.next(t, 10*time.Second)
		if !ok || !strings.Contains(line, fmt.Sprintf(`"id":%d`, id)) {
			t.Errorf("adapter no longer serves requests after batch: %q", line)
		}
	}
	t.Run("two requests", func(t *testing.T) {
		c := f.start("claude")
		c.send(`[{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"2.0","id":"b","method":"ping"}]`)
		line, ok := c.next(t, 25*time.Second)
		if !ok {
			t.Fatalf("no batch reply")
		}
		if replies := decode(t, line); len(replies) != 2 {
			t.Errorf("want 2 replies, got %q", line)
		}
		alive(t, c, 9)
	})
	t.Run("request and notification", func(t *testing.T) {
		c := f.start("codex")
		c.send(`[{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"2.0","method":"notifications/initialized"}]`)
		line, ok := c.next(t, 25*time.Second)
		if !ok {
			t.Fatalf("no batch reply")
		}
		if replies := decode(t, line); len(replies) != 1 || replies[0]["id"] != float64(1) {
			t.Errorf("want only the request's reply, got %q", line)
		}
		alive(t, c, 9)
	})
	t.Run("notifications only", func(t *testing.T) {
		c := f.start("grok")
		c.send(`[{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","method":"notifications/cancelled"}]`)
		c.send(`{"jsonrpc":"2.0","id":9,"method":"ping"}`)
		line, ok := c.next(t, 25*time.Second)
		if !ok || !strings.Contains(line, `"id":9`) {
			t.Errorf("notification batch produced output or killed adapter: %q", line)
		}
	})
	// The in-flight case: a batch line must not abandon an earlier request.
	t.Run("batch does not drop in-flight reply", func(t *testing.T) {
		c := f.start("claude")
		c.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
		if line, ok := c.next(t, 25*time.Second); !ok {
			t.Fatalf("warm-up reply: %q", line)
		}
		c.send(`{"jsonrpc":"2.0","id":"held","method":"slow"}`)
		time.Sleep(300 * time.Millisecond)
		c.send(`[{"jsonrpc":"2.0","id":2,"method":"ping"}]`)
		time.Sleep(300 * time.Millisecond)
		// The slow channel closes once per fixture, so this subtest runs last.
		f.unblock()
		var lines []string
		for {
			line, ok := c.next(t, 5*time.Second)
			if !ok {
				break
			}
			lines = append(lines, line)
			if len(lines) == 2 {
				break
			}
		}
		if !strings.Contains(strings.Join(lines, ""), `"held"`) {
			t.Errorf("in-flight reply lost after batch line: %q", lines)
		}
	})
}

// JSON-RPC 2.0 answers unparsable input with -32700 and id null. The adapter
// used to exit instead, abandoning replies still in flight.
func TestMCPAdapterParseErrorKeepsSession(t *testing.T) {
	f := newMCPFixture(t)
	c := f.start("claude")
	c.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if line, ok := c.next(t, 25*time.Second); !ok {
		t.Fatalf("warm-up reply: %q", line)
	}
	c.send(`{"jsonrpc":"2.0","id":"held","method":"slow"}`)
	time.Sleep(300 * time.Millisecond)
	c.send(`{not json`)
	c.send(`5`)
	c.send(`{"jsonrpc":"2.0","id":9,"method":"ping"}`)
	time.Sleep(300 * time.Millisecond)
	f.unblock()
	var lines []string
	for len(lines) < 4 {
		line, ok := c.next(t, 10*time.Second)
		if !ok {
			break
		}
		lines = append(lines, line)
	}
	joined := strings.Join(lines, "")
	for _, want := range []string{"-32700", "-32600", `"id":9`, `"held"`} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %s after invalid input: %q", want, lines)
		}
	}
}

// Like the API dispatcher, a null id is a notification and gets no reply.
func TestMCPAdapterNullIDIsNotification(t *testing.T) {
	f := newMCPFixture(t)
	c := f.start("codex")
	c.send(`{"jsonrpc":"2.0","id":null,"method":"notifications/initialized"}`)
	c.send(`{"jsonrpc":"2.0","id":9,"method":"ping"}`)
	line, ok := c.next(t, 25*time.Second)
	if !ok || !strings.Contains(line, `"id":9`) {
		t.Errorf("null-id notification produced a reply: %q", line)
	}
}

// A mixed batch passes the server's per-member answers through, including its
// id null Invalid Request. A reply lost for one member becomes that member's
// unknown outcome while the others keep their results, and nothing is resent.
func TestMCPAdapterMixedBatch(t *testing.T) {
	f := newMCPFixture(t)
	c := f.start("grok")
	c.send(`[{"jsonrpc":"2.0","id":1,"method":"tools/list"},5,{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":"x","method":"ping"}]`)
	line, ok := c.next(t, 25*time.Second)
	var replies []struct {
		ID    any
		Error *struct{ Code int }
	}
	if !ok || json.Unmarshal([]byte(line), &replies) != nil || len(replies) != 3 {
		t.Fatalf("want 3 replies (two requests, one invalid member): %q", line)
	}
	invalid := 0
	for _, reply := range replies {
		if reply.ID == nil && reply.Error != nil && reply.Error.Code == -32600 {
			invalid++
		}
	}
	if invalid != 1 {
		t.Errorf("invalid member answer not passed through: %q", line)
	}
	before := f.dispatched.Load()
	c.send(`[{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"2.0","id":2,"method":"drop"}]`)
	line, ok = c.next(t, 25*time.Second)
	var partial []struct {
		ID     int
		Result json.RawMessage
		Error  *struct {
			Data struct {
				Unknown bool `json:"outcome_unknown"`
			}
		}
	}
	if !ok || json.Unmarshal([]byte(line), &partial) != nil || len(partial) != 2 {
		t.Fatalf("partial batch reply: %q", line)
	}
	for _, reply := range partial {
		if reply.ID == 1 && (len(reply.Result) == 0 || reply.Error != nil) {
			t.Errorf("answered member lost its result: %q", line)
		}
		if reply.ID == 2 && (reply.Error == nil || !reply.Error.Data.Unknown) {
			t.Errorf("unanswered member not reported as unknown outcome: %q", line)
		}
	}
	time.Sleep(500 * time.Millisecond)
	if got := f.dispatched.Load() - before; got != 1 {
		t.Errorf("partial batch dispatched %d times, want exactly 1", got)
	}
}

// The API answers invalid members and malformed objects with id null -32600
// even when nothing in the line carries an id; only valid notifications are
// silent. The adapter must pass those answers through, never synthesize any.
func TestMCPAdapterInvalidWithoutIDParity(t *testing.T) {
	f := newMCPFixture(t)
	c := f.start("claude")
	invalid := func(t *testing.T, line string, count int) {
		t.Helper()
		var replies []struct {
			ID    any
			Error struct{ Code int }
		}
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "{") {
			trimmed = "[" + trimmed + "]"
		}
		if json.Unmarshal([]byte(trimmed), &replies) != nil || len(replies) != count {
			t.Errorf("want %d id-null -32600 answers, got %q", count, line)
			return
		}
		for _, reply := range replies {
			if reply.ID != nil || reply.Error.Code != -32600 {
				t.Errorf("not an id-null Invalid Request: %q", line)
			}
		}
	}
	for _, test := range []struct {
		name, line string
		count      int
	}{
		{"invalid-only batch", `[5]`, 1},
		{"invalid and notification batch", `[5,{"jsonrpc":"2.0","method":"notifications/initialized"},"x"]`, 2},
		{"object without method", `{"jsonrpc":"2.0"}`, 1},
		{"object without jsonrpc", `{"method":"ping"}`, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			c.send(test.line)
			line, ok := c.next(t, 10*time.Second)
			if !ok {
				t.Fatalf("server answer dropped")
			}
			invalid(t, line, test.count)
		})
	}
	// Valid notifications stay silent; the next line answers the ping.
	c.send(`[{"jsonrpc":"2.0","method":"notifications/initialized"}]`)
	c.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	c.send(`{"jsonrpc":"2.0","id":9,"method":"ping"}`)
	if line, ok := c.next(t, 25*time.Second); !ok || !strings.Contains(line, `"id":9`) {
		t.Errorf("notification answered or session lost: %q", line)
	}
}

// A native client that stops reading stdout must not keep the adapter alive
// after SIGTERM: blocked reply writes cannot hold shutdown forever, including
// after the client has already closed stdin.
func TestMCPAdapterSIGTERMWithStalledStdout(t *testing.T) {
	for _, closeStdin := range []bool{false, true} {
		t.Run(fmt.Sprintf("stdin closed=%v", closeStdin), func(t *testing.T) {
			f := newMCPFixture(t)
			cmd := exec.Command(f.binary, "communicator", "mcp", "codex")
			cmd.Env = f.env
			in, _ := cmd.StdinPipe()
			stdout, _ := cmd.StdoutPipe()
			stderr := &bytes.Buffer{}
			f.stderr = append(f.stderr, stderr)
			cmd.Stderr = stderr
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			go func() { cmd.Wait(); close(done) }()
			t.Cleanup(func() { in.Close(); cmd.Process.Kill(); <-done })
			// Warm up with one read so the signal handler and lease exist.
			fmt.Fprintln(in, `{"jsonrpc":"2.0","id":0,"method":"tools/list"}`)
			first, err := bufio.NewReader(stdout).ReadString('\n')
			if err != nil || !strings.Contains(first, "tools/list") {
				t.Fatalf("warm-up: %q %v", first, err)
			}
			// Then stop reading: 16 x 256 KiB replies overrun any pipe buffer.
			for i := 1; i <= 16; i++ {
				fmt.Fprintf(in, "{\"jsonrpc\":\"2.0\",\"id\":%d,\"method\":\"big\"}\n", i)
			}
			time.Sleep(2 * time.Second)
			if closeStdin {
				in.Close()
				time.Sleep(500 * time.Millisecond)
			}
			cmd.Process.Signal(syscall.SIGTERM)
			start := time.Now()
			select {
			case <-done:
				t.Logf("exited %s after SIGTERM with stdout unread", time.Since(start).Round(time.Millisecond))
			case <-time.After(15 * time.Second):
				t.Errorf("adapter still alive 15s after SIGTERM while stdout is not read")
			}
		})
	}
}

// Replies are relayed byte-exact: an id beyond float64 precision must reach
// stdout unchanged, single and batched, as sameMCPID already compares it.
func TestMCPAdapterPreservesLargeIDsOnTheWire(t *testing.T) {
	f := newMCPFixture(t)
	c := f.start("claude")
	const id = "9007199254740993"
	for _, line := range []string{
		`{"jsonrpc":"2.0","id":` + id + `,"method":"ping"}`,
		`[{"jsonrpc":"2.0","id":` + id + `,"method":"ping"}]`,
		`{"jsonrpc":"2.0","id":` + id + `,"method":"drop"}`,
	} {
		c.send(line)
		reply, ok := c.next(t, 25*time.Second)
		if !ok || !strings.Contains(reply, `"id":`+id) {
			t.Errorf("%s: id not preserved on stdout: %q", line, reply)
		}
	}
}

func TestMCPAdapterRejectsMalformedErrorWithoutReplay(t *testing.T) {
	f := newMCPFixture(t)
	for _, engine := range []string{"codex", "claude", "grok"} {
		c := f.start(engine)
		for _, request := range []string{`{"jsonrpc":"2.0","id":1,"method":"bad-error"}`, `[{"jsonrpc":"2.0","id":1,"method":"bad-error"}]`} {
			before := f.dispatched.Load()
			c.send(request)
			reply, ok := c.next(t, 25*time.Second)
			if !ok || !strings.Contains(reply, `"id":1`) || !strings.Contains(reply, `"outcome_unknown":true`) {
				t.Fatalf("%s: malformed error was forwarded: %s", engine, reply)
			}
			if f.dispatched.Load() != before+1 {
				t.Fatal("malformed response replayed the operation")
			}
		}
	}
}
