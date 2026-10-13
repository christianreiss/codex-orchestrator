package agentbus

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

// The signed helper composes real owner/controller code but substitutes only
// the provider executable. It never launches a managed AI agent or uses fleet
// credentials. The fixed -test.run below prevents recursive test-suite starts.
func TestResidentCombinedProcessHelper(t *testing.T) {
	if os.Getenv("CXX_RESIDENT_INTEGRATION_CHILD") != "1" {
		t.Skip("subprocess helper")
	}
	daemonExecutable = func() (string, error) { return os.Getenv("CXX_RESIDENT_NATIVE_FIXTURE"), nil }
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := communicator.ServeResident(ctx, os.Getenv("CDX_CONFIG_PATH"), "resident-test", communicator.ResidentOptions{
		Controller: func() residency.ExecutionController {
			return NewResidentController("resident-test", io.Discard, os.Stderr)
		},
		DirectDaemon: func(context.Context, string) (residency.DaemonStream, error) {
			return nil, errors.New("shared transport unexpectedly bypassed")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
}

type residentFixtureFrame struct {
	Type     string          `json:"type,omitempty"`
	ID       string          `json:"id,omitempty"`
	Path     string          `json:"path,omitempty"`
	Status   int             `json:"status,omitempty"`
	Body     []byte          `json:"body,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
	Accepted *bool           `json:"accepted,omitempty"`
}

type combinedResidentFixture struct {
	op                   daemonOperation
	settings             daemonSettings
	mu                   sync.Mutex
	ws                   *websocket.Conn
	accepts, completions atomic.Int32
	delivered            atomic.Bool
	replySeen            chan struct{}
	stopReply            chan bool
	errors               chan error
	directCalls          atomic.Int32
}

func (f *combinedResidentFixture) check(err error) {
	if err != nil {
		select {
		case f.errors <- err:
		default:
		}
	}
}
func (f *combinedResidentFixture) handle(ws *websocket.Conn) {
	defer ws.Close()
	f.mu.Lock()
	f.ws = ws
	f.mu.Unlock()
	for {
		var frame residentFixtureFrame
		if websocket.JSON.Receive(ws, &frame) != nil {
			return
		}
		send := func(value any) { f.check(websocket.JSON.Send(ws, value)) }
		switch frame.Type {
		case "hello":
			send(map[string]any{"type": "ready", "protocol": 1, "control": []string{"terminate", "owner_identity"}})
		case "heartbeat":
			send(map[string]string{"type": "heartbeat"})
		case "request":
			if frame.Path == "/host/daemon/config" {
				body, _ := json.Marshal(f.settings)
				send(residentFixtureFrame{ID: frame.ID, Status: 200, Body: body})
			} else {
				send(residentFixtureFrame{ID: frame.ID, Status: 404, Body: []byte(`{}`)})
			}
		case "terminate_ack":
			if frame.Accepted == nil {
				f.check(errors.New("stop acknowledgement omitted acceptance"))
				return
			}
			select {
			case f.stopReply <- *frame.Accepted:
			default:
			}
		case "daemon":
			var call struct {
				Type, ID string
				Payload  json.RawMessage
			}
			if err := json.Unmarshal(frame.Payload, &call); err != nil {
				f.check(err)
				return
			}
			reply := func(result any) {
				body, _ := json.Marshal(map[string]any{"id": call.ID, "result": result})
				send(residentFixtureFrame{Type: "daemon_event", Payload: body})
			}
			switch call.Type {
			case "hello":
				reply(map[string]any{"settings": f.settings})
				if f.delivered.CompareAndSwap(false, true) {
					body, _ := json.Marshal(map[string]any{"type": "operation", "operation": f.op})
					send(residentFixtureFrame{Type: "daemon_event", Payload: body})
				}
			case "accept":
				var payload struct {
					Operation string `json:"operation_id"`
					Claim     string `json:"claim_id"`
				}
				if err := json.Unmarshal(call.Payload, &payload); err != nil {
					f.check(err)
					return
				}
				if payload.Operation != f.op.ID || payload.Claim != f.op.Claim {
					f.check(errors.New("accept changed durable claim identity"))
					return
				}
				f.accepts.Add(1)
				reply(map[string]bool{"accepted": true})
			case "complete":
				var payload struct {
					Operation string       `json:"operation_id"`
					Claim     string       `json:"claim_id"`
					Result    daemonResult `json:"result"`
				}
				if err := json.Unmarshal(call.Payload, &payload); err != nil {
					f.check(err)
					return
				}
				if payload.Operation != f.op.ID || payload.Claim != f.op.Claim || payload.Result.Status != "completed" || payload.Result.Reply != "hello" || payload.Result.Upstream != "native-fixture" {
					f.check(fmt.Errorf("completion changed: %+v", payload))
					return
				}
				if f.completions.Add(1) == 1 {
					return
				} // Drop the first ACK after receiving the durable result.
				reply(map[string]bool{"accepted": true})
				select {
				case f.replySeen <- struct{}{}:
				default:
				}
			default:
				reply(map[string]bool{"accepted": true})
			}
		}
	}
}

func TestResidentCombinedAdaptersDrainAndRecoverLostCompletionWithoutReplay(t *testing.T) {
	if runtime.GOOS != "linux" || testing.Short() {
		t.Skip("Linux signed composed-process fixture")
	}
	root := t.TempDir()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	key := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	helper := filepath.Join(root, "resident-helper")
	build := exec.Command("go", "test", "-race", "-c", "-o", helper, "-ldflags", "-X github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing.buildPublicKeyB64="+key, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("helper build: %v %s", err, out)
	}
	helperDigest, err := residency.DigestFile(helper)
	if err != nil {
		t.Fatal(err)
	}
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			home := t.TempDir()
			runtimeRoot, err := os.MkdirTemp("", "cc-combined-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(runtimeRoot)
			fixture := &combinedResidentFixture{op: daemonOperation{ID: uuid.NewString(), Claim: uuid.NewString(), Session: uuid.NewString(), Engine: engine, Cwd: home, Title: "test", Prompt: "hello", Upstream: "native-fixture"}, settings: daemonSettings{Enabled: true, ResidentEnabled: true, Username: currentUserName(), MaxParallel: 1}, replySeen: make(chan struct{}, 1), stopReply: make(chan bool, 1), errors: make(chan error, 8)}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/host/communicator/connect" {
					websocket.Handler(fixture.handle).ServeHTTP(w, r)
					return
				}
				fixture.directCalls.Add(1)
				if r.Method == http.MethodGet && r.URL.Path == "/host/daemon/config" {
					json.NewEncoder(w).Encode(fixture.settings)
					return
				}
				if r.Method == http.MethodGet && r.URL.Path == "/wrapper/v2/config" {
					w.WriteHeader(404)
					return
				}
				if r.Method == http.MethodPost && r.URL.Path == "/host/agent-relays/register" {
					w.WriteHeader(404)
					return
				}
				fixture.check(fmt.Errorf("unexpected direct API request: %s %s", r.Method, r.URL.Path))
				w.WriteHeader(500)
			}))
			defer upstream.Close()
			namespace, _ := residency.Namespace(os.Getuid(), runtimeRoot)
			coordination := filepath.Join("/tmp", fmt.Sprintf("cxx-%d", os.Getuid()), "owner-"+residency.Key(os.Getuid(), upstream.URL, namespace))
			t.Cleanup(func() { os.RemoveAll(coordination) })
			binDir := filepath.Join(home, "bin")
			if err := os.Mkdir(binDir, 0700); err != nil {
				t.Fatal(err)
			}
			script := `#!/bin/sh
[ "$CXX_DAEMON_NATIVE_WRITER_ID" = "native-fixture" ] || exit 47
printf '%s\n' "$1" >> "$CXX_RESIDENT_FIXTURE_ROOT/launches"
while [ ! -f "$CXX_RESIDENT_FIXTURE_ROOT/release" ]; do sleep 0.02; done
case "$1" in
 codex) printf '%s\n' '{"type":"thread.started","thread_id":"native-fixture"}' '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}' ;;
 claude) printf '%s\n' '{"result":"hello","session_id":"native-fixture","subtype":"success"}' ;;
 grok) printf '%s\n' '{"text":"hello","sessionId":"native-fixture","stopReason":"end_turn"}' ;;
esac
`
			native := filepath.Join(binDir, "native-fixture")
			if err := os.WriteFile(native, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			for _, e := range []string{"codex", "claude", "grok"} {
				if err := os.Symlink(native, filepath.Join(binDir, e)); err != nil {
					t.Fatal(err)
				}
			}
			env := []string{"HOME=" + home, "XDG_RUNTIME_DIR=" + runtimeRoot, "PATH=" + binDir + ":/usr/bin:/bin", "CXX_RESIDENT_INTEGRATION_CHILD=1", "CXX_RESIDENT_NATIVE_FIXTURE=" + native, "CXX_RESIDENT_FIXTURE_ROOT=" + home, "CODEX_HOME=" + filepath.Join(home, "codex"), "CLAUDE_CONFIG_DIR=" + filepath.Join(home, "claude"), "CGX_HOME=" + filepath.Join(home, "grok")}
			for _, e := range []string{"codex", "claude", "grok"} {
				cfg := config.Config{SchemaVersion: 1, Engine: e, IssuedAt: time.Now().UTC().Format(time.RFC3339), Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "fixture-key", InstallationID: "fixture", CommunicatorProtocol: 1, CommunicatorRuntimeProtocol: 1}, Host: config.Host{ID: 1, FQDN: "fixture.example", Secure: true}, Wrapper: config.Wrapper{Version: "resident-test", Track: "stable", BinaryURL: upstream.URL + "/download", BinarySHA256: strings.Repeat("0", 64)}}
				cfg.AgentMessaging = config.AgentMessaging{Enabled: true, RelayPollSeconds: 1, QueuedTTLSeconds: 300}
				path := filepath.Join(home, e+".json")
				raw, _ := json.Marshal(cfg)
				if err := os.WriteFile(path, raw, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path+".sig", ed25519.Sign(priv, raw), 0600); err != nil {
					t.Fatal(err)
				}
				env = append(env, map[string]string{"codex": "CDX_CONFIG_PATH", "claude": "CLX_CONFIG_PATH", "grok": "CGX_CONFIG_PATH"}[e]+"="+path)
			}
			cmd := exec.Command(helper, "-test.run=^TestResidentCombinedProcessHelper$", "-test.timeout=35s")
			cmd.Env = env
			log, err := os.Create(filepath.Join(home, "owner.log"))
			if err != nil {
				t.Fatal(err)
			}
			defer log.Close()
			cmd.Stdout, cmd.Stderr = log, log
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			exits := make(chan error, 1)
			go func() { exits <- cmd.Wait(); close(done) }()
			t.Cleanup(func() {
				cmd.Process.Signal(syscall.SIGTERM)
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					cmd.Process.Kill()
					<-done
				}
			})
			sum := sha256.Sum256([]byte(upstream.URL))
			socket := filepath.Join(runtimeRoot, "cxx-comm-"+hex.EncodeToString(sum[:8]), "control.sock")
			client := &http.Client{Timeout: time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socket)
			}}}
			wait := func(check func() bool) {
				t.Helper()
				deadline := time.Now().Add(12 * time.Second)
				for time.Now().Before(deadline) {
					if check() {
						return
					}
					select {
					case err := <-fixture.errors:
						t.Fatal(err)
					case <-done:
						out, _ := os.ReadFile(filepath.Join(home, "owner.log"))
						t.Fatalf("owner exited: %s", out)
					case <-time.After(30 * time.Millisecond):
					}
				}
				out, _ := os.ReadFile(filepath.Join(home, "owner.log"))
				t.Fatalf("fixture timed out: accepts=%d completions=%d log=%s", fixture.accepts.Load(), fixture.completions.Load(), out)
			}
			wait(func() bool { _, err := os.Stat(filepath.Join(home, "launches")); return err == nil })

			locks, err := filepath.Glob(filepath.Join(home, ".cxx", "agent", "locks", engine+"-*.lock"))
			if err != nil || len(locks) != 1 {
				t.Fatalf("native writer lease missing: %v %v", locks, err)
			}
			if contender, err := ipc.TryAcquireExclusivePath(locks[0]); err == nil {
				contender.Release()
				t.Fatal("another writer entered the accepted native session")
			} else if !errors.Is(err, ipc.ErrHeld) {
				t.Fatal(err)
			}
			var status struct {
				Owner     string                    `json:"owner_instance_id"`
				Digest    string                    `json:"binary_sha256"`
				PID       int                       `json:"pid"`
				Execution residency.ExecutionStatus `json:"execution"`
			}
			response, err := client.Get("http://communicator.local/_comm/status")
			if err != nil {
				t.Fatal(err)
			}
			if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if status.Digest != helperDigest || status.PID != cmd.Process.Pid || status.Execution.Workload.Accepted != 1 || status.Execution.Workload.Children != 1 || status.Execution.Workload.Quiet() {
				t.Fatalf("accepted work omitted from status: %+v", status)
			}

			terminate := func(expect bool) {
				t.Helper()
				fixture.mu.Lock()
				ws := fixture.ws
				fixture.mu.Unlock()
				if ws == nil {
					t.Fatal("control connection missing")
				}
				if err := websocket.JSON.Send(ws, map[string]any{"type": "terminate", "request_id": uuid.NewString(), "owner_instance_id": status.Owner}); err != nil {
					t.Fatal(err)
				}
				select {
				case accepted := <-fixture.stopReply:
					if accepted != expect {
						t.Fatalf("remote stop accepted=%t expected=%t", accepted, expect)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("remote stop acknowledgement missing")
				}
			}
			terminate(false)
			body, _ := json.Marshal(map[string]string{"request_id": uuid.NewString(), "owner_instance_id": status.Owner, "command": "prepare"})
			response, err = client.Post("http://communicator.local/_comm/handoff", "application/json", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			refusal, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != 409 || !strings.Contains(string(refusal), "execution_busy") {
				t.Fatalf("accepted native process was stoppable: %d %s", response.StatusCode, refusal)
			}
			if err := os.WriteFile(filepath.Join(home, "release"), nil, 0600); err != nil {
				t.Fatal(err)
			}
			wait(func() bool {
				select {
				case <-fixture.replySeen:
					return true
				default:
					return false
				}
			})
			wait(func() bool {
				_, err := os.Stat(filepath.Join(home, ".cxx", "daemon", fixture.op.ID+".json"))
				return errors.Is(err, os.ErrNotExist)
			})
			launches, err := os.ReadFile(filepath.Join(home, "launches"))
			if err != nil {
				t.Fatal(err)
			}
			if strings.TrimSpace(string(launches)) != engine || fixture.accepts.Load() != 1 || fixture.completions.Load() != 2 {
				t.Fatalf("replay or bypass: launches=%q accepts=%d completions=%d direct=%d", launches, fixture.accepts.Load(), fixture.completions.Load(), fixture.directCalls.Load())
			}

			contender, err := ipc.TryAcquireExclusivePath(locks[0])
			if err != nil {
				t.Fatalf("native writer lease did not drain: %v", err)
			}
			contender.Release()
			// Probe readiness after receipt recovery, prepare locally, then confirm
			// that negotiated remote termination exits the now-quiet owner.
			wait(func() bool {
				response, err := client.Get("http://communicator.local/_comm/status")
				if err != nil {
					return false
				}
				defer response.Body.Close()
				if json.NewDecoder(response.Body).Decode(&status) != nil {
					return false
				}
				return status.Execution.Verified && status.Execution.Workload.Quiet()
			})
			body, _ = json.Marshal(map[string]string{"request_id": uuid.NewString(), "owner_instance_id": status.Owner, "command": "prepare"})
			response, err = client.Post("http://communicator.local/_comm/handoff", "application/json", bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatalf("drained runtime could not prepare: HTTP %d", response.StatusCode)
			}
			terminate(true)
			select {
			case <-done:
				if err := <-exits; err != nil {
					out, _ := os.ReadFile(filepath.Join(home, "owner.log"))
					t.Fatalf("owner shutdown: %v %s", err, out)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("acknowledged quiet owner did not exit")
			}
			select {
			case err := <-fixture.errors:
				t.Fatal(err)
			default:
			}
		})
	}
}
