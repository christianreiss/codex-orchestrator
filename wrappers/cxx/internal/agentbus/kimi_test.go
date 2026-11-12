package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testKimiID = "session_11111111-1111-4111-8111-111111111111"

func TestKimiNativeOutput(t *testing.T) {
	for _, tc := range []struct{ name, raw, reply, id string }{
		{"real success", `{"role":"meta","type":"system.version","version":"2.5.3"}` + "\n" + `{"role":"assistant","content":"intermediate","tool_calls":[{"id":"call"}]}` + "\n" + `{"role":"tool","content":"secret tool result"}` + "\n" + `{"role":"assistant","content":"done"}` + "\n" + `{"role":"meta","type":"session.resume_hint","session_id":"` + testKimiID + `"}`, "done", testKimiID},
		{"no auth", `{"role":"meta","type":"system.version","version":"2.5.3"}`, "", ""},
		{"error clears partial", "{\"role\":\"assistant\",\"content\":\"partial\"}\n{\"type\":\"error\",\"message\":\"failed\"}", "", ""},
		{"tool only", `{"role":"assistant","content":"working","tool_calls":[{}]}`, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reply, id := parseNativeOutput("kimi", []byte(tc.raw))
			if reply != tc.reply || id != tc.id {
				t.Fatalf("%q %q", reply, id)
			}
		})
	}
}
func TestKimiHeadlessAndRebootArgs(t *testing.T) {
	got := nativeArgs("kimi", testKimiID, "model-probe")
	want := []string{"kimi", "--skip-boot", "run", "--output-format", "stream-json", "-m", "model-probe", "-S", testKimiID}
	if !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	got = rebootInteractiveArgs("kimi", testKimiID, "checkpoint")
	if !strings.Contains(strings.Join(got, " "), "-S "+testKimiID+" -p checkpoint") {
		t.Fatal(got)
	}
	if strings.Contains(strings.Join(got, " "), "--auto") {
		t.Fatal("2.5.3 rejects --auto with -p")
	}
}
func TestKimiTranscriptAndTitle(t *testing.T) {
	home := t.TempDir()
	t.Setenv("KIMI_CODE_HOME", home)
	if !errors.Is(checkKimiTranscript(testKimiID), errNativeTranscriptMissing) {
		t.Fatal("missing transcript accepted")
	}
	root := filepath.Join(home, "sessions", "wd_probe_hash", testKimiID)
	path := filepath.Join(root, "agents", "main", "wire.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkKimiTranscript(testKimiID); err != nil {
		t.Fatal(err)
	}
	if err := checkRebootTranscript("kimi", testKimiID); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "state.json"), []byte(`{"id":"`+testKimiID+`","title":"Probe title"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got := nativeSessionName(home, "kimi", testKimiID); got != "Probe title" {
		t.Fatal(got)
	}
	if err := checkKimiTranscript("../escape"); err == nil {
		t.Fatal("path traversal accepted")
	}
}
func TestKimiHookDialectGolden(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "hook-test")
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "kimi")
	for _, event := range []string{hookEventPrompt, hookEventStop} {
		t.Run(event, func(t *testing.T) {
			var encoded, stdout, stderr bytes.Buffer
			box := &mailbox{Pending: []mailboxEntry{{MessageID: "message-" + event, Kind: "message", From: mailboxPeer{Alias: "Peer", Engine: "kimi"}}}}
			if err := emitHook(&encoded, event, box, nil); err != nil {
				t.Fatal(err)
			}
			err := emitKimiHook(event, encoded.Bytes(), &stdout, &stderr)
			if event == hookEventStop {
				if !errors.Is(err, errKimiStopBlocked) || stdout.Len() != 0 || !strings.Contains(stderr.String(), "message-Stop") {
					t.Fatalf("%v %q %q", err, stdout.String(), stderr.String())
				}
			} else if err != nil || stderr.Len() != 0 || !strings.Contains(stdout.String(), "message-UserPromptSubmit") || strings.Contains(stdout.String(), "hookSpecificOutput") {
				t.Fatalf("%v %q", err, stdout.String())
			}
			encoded.Reset()
			if err := emitHook(&encoded, event, box, nil); err != nil || encoded.Len() != 0 {
				t.Fatal("ring repeated", err)
			}
		})
	}
	for _, raw := range []string{"", "{", "{}"} {
		var out, diag bytes.Buffer
		if err := runKimiPoll(hookEventStop, strings.NewReader(raw), &out, &diag); err != nil || out.Len() != 0 || diag.Len() != 0 {
			t.Fatal("hook failed closed")
		}
	}
	var out, diag bytes.Buffer
	if code := RunCommand([]string{"poll", "--hook", "Stop", "--dialect", "kimi"}, strings.NewReader("{}"), &out, &diag, "test"); code != 0 || out.Len() != 0 || diag.Len() != 0 {
		t.Fatal(code, out.String(), diag.String())
	}
}
func TestKimiReceiverRegistersButNeverClaimsOrPushesIdle(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "kimi")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	registered := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		switch filepath.Base(req.URL.Path) {
		case "native":
			_ = json.NewEncoder(w).Encode(map[string]any{"native_session_id": testKimiID})
		case "register":
			if body["protocol"] != "kimi-hooks-v1" {
				t.Error(body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"sources": []string{"peer", "portal"}})
			registered <- struct{}{}
		case "activity-hook":
			_ = json.NewEncoder(w).Encode(map[string]any{"state": "idle", "source": "kimi-hooks"})
		case "stop":
			_, _ = io.WriteString(w, "{}")
		default:
			t.Errorf("idle hook receiver attempted %s", req.URL.Path)
			_, _ = io.WriteString(w, "{}")
		}
	}))
	defer server.Close()
	c := &sessionClient{id: "launch", http: &http.Client{Transport: rewriteTransport{server: server}}}
	r := &autoReceiver{client: c, tracker: newChannelTracker(c)}
	done := make(chan error, 1)
	go func() { done <- r.connection(ctx) }()
	select {
	case <-registered:
	case <-time.After(time.Second):
		t.Fatal("not registered")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("receiver did not stop")
	}
}

func TestKimiPollCommandsUseNativeExitProtocol(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "kimi")
	t.Setenv(envSessionID, "kimi-poll")
	socket := filepath.Join(t.TempDir(), "broker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var available atomic.Bool
	available.Store(true)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !available.Load() {
			w.WriteHeader(503)
			return
		}
		switch filepath.Base(r.URL.Path) {
		case "native", "activity-hook":
			_, _ = io.WriteString(w, "{}")
		case "mailbox":
			_, _ = io.WriteString(w, `{"pending":[{"message_id":"peer-pending","kind":"message","from":{"alias":"Peer","engine":"kimi"}},{"source":"portal","message_id":"portal-pending","kind":"portal","from":{"address":"admin:7","alias":"Operator","engine":"operator","fqdn":null},"expires_at":null}]}`)
		default:
			t.Errorf("hook attempted unexpected operation %s", r.URL.Path)
			w.WriteHeader(400)
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	t.Setenv(envSocket, socket)
	for _, event := range []string{hookEventPrompt, hookEventStop} {
		var out, diag bytes.Buffer
		payload := `{"hook_event_name":"` + event + `","session_id":"` + testKimiID + `","prompt":[{"type":"text","text":"probe"}]}`
		args := []string{"poll", "--hook", event, "--dialect", "kimi"}
		code := RunCommand(args, strings.NewReader(payload), &out, &diag, "test")
		if event == hookEventStop {
			if code != 2 || out.Len() != 0 || (!strings.Contains(diag.String(), "peer-pending") || !strings.Contains(diag.String(), "portal-pending")) {
				t.Fatal(code, out.String(), diag.String())
			}
		} else if code != 0 || diag.Len() != 0 || (!strings.Contains(out.String(), "peer-pending") || !strings.Contains(out.String(), "portal-pending")) {
			t.Fatal(code, out.String(), diag.String())
		}
		out.Reset()
		diag.Reset()
		if code = RunCommand(args, strings.NewReader(payload), &out, &diag, "test"); code != 0 || out.Len() != 0 || diag.Len() != 0 {
			t.Fatal("duplicate ring", code)
		}
	}
	available.Store(false)
	var out, diag bytes.Buffer
	if code := RunCommand([]string{"poll", "--hook", "Stop", "--dialect", "kimi"}, strings.NewReader(`{"hook_event_name":"Stop","session_id":"`+testKimiID+`"}`), &out, &diag, "test"); code != 0 || out.Len() != 0 || diag.Len() != 0 {
		t.Fatal("unavailable hook blocked", code)
	}
}

func TestKimiListenPreservesPortalAuthorityAndOwnership(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "kimi")
	var claims, accepts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		switch {
		case strings.HasSuffix(req.URL.Path, "/mailbox"):
			_, _ = io.WriteString(w, `{"pending":[{"message_id":"portal-1","source":"portal","kind":"portal"}]}`)
		case strings.HasSuffix(req.URL.Path, "/receiver/claim"):
			claims++
			if body["source"] != "portal" || body["generation"] != "generation" {
				t.Error(body)
			}
			_, _ = io.WriteString(w, `{"message":{"message_id":"portal-1","lease_owner":"owner","content":"operator instruction"}}`)
		case strings.HasSuffix(req.URL.Path, "/portal-1/ack"):
			accepts++
			if body["outcome"] != "accepted" {
				t.Error(body)
			}
			_, _ = io.WriteString(w, `{"status":"accepted"}`)
		default:
			t.Errorf("unexpected source operation %s", req.URL.Path)
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	c := &sessionClient{id: "launch", http: &http.Client{Transport: rewriteTransport{server: server}}}
	tracker := newChannelTracker(c)
	r := &autoReceiver{client: c, tracker: tracker, generation: "generation", connected: true, sources: []string{"peer", "portal"}, lastBeatOK: time.Now()}
	tracker.receiver = r
	result, handled, err := r.kimiPortalListen(context.Background())
	if err != nil || !handled || result["source"] != "portal" || claims != 1 || accepts != 1 || r.pendingPortal == nil {
		t.Fatalf("%v %v %v claims=%d accepts=%d", result, handled, err, claims, accepts)
	}
	if tracker.get("portal-1") != nil {
		t.Fatal("operator instruction crossed into peer receipts")
	}
	if _, err := callMCPTool(context.Background(), c, tracker, "agent_reply", map[string]any{"message_id": "portal-1", "content": "wrong reply tool"}); err == nil {
		t.Fatal("peer reply accepted for operator instruction")
	}
	result, err = agentListen(context.Background(), c, tracker, map[string]any{})
	if err != nil || result["status"] != "portal_pending" || claims != 1 || r.pendingPortal == nil {
		t.Fatalf("listen released operator work: %v %v", result, err)
	}
}

func TestKimiRebootPinsDurableHome(t *testing.T) {
	t.Setenv("KIMI_CODE_HOME", filepath.Join(t.TempDir(), "disposable", "home"))
	base := t.TempDir()
	t.Setenv("CXX_KIMI_BASE_HOME", base)
	env, err := rebootEnvironment("kimi")
	if err != nil || !strings.Contains(strings.Join(env, "\n"), "KIMI_CODE_HOME="+base) || strings.Contains(strings.Join(env, "\n"), "disposable") {
		t.Fatal(env, err)
	}
	t.Setenv("CXX_KIMI_BASE_HOME", "")
	if _, err := rebootEnvironment("kimi"); err == nil {
		t.Fatal("reboot persisted disposable runtime home")
	}
}
func TestKimiResumeChecksTranscriptBeforeStarting(t *testing.T) {
	root := t.TempDir()
	t.Setenv("KIMI_CODE_HOME", root)
	previous := startNativeCommand
	t.Cleanup(func() { startNativeCommand = previous })
	started := false
	startNativeCommand = func(*exec.Cmd) error { started = true; return errors.New("fixture start failure") }
	client := &relayClient{http: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	delivery := &relayDelivery{Target: map[string]any{"engine": "kimi", "cwd": root}}
	result := client.runNative(context.Background(), &config.Config{}, delivery, testKimiID, true)
	if started || result.Started || !result.MissingTranscript || !errors.Is(result.Err, errNativeTranscriptMissing) {
		t.Fatalf("missing session was started: %+v", result)
	}
	path := filepath.Join(root, "sessions", "project", testKimiID, "agents", "main", "wire.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	result = client.runNative(context.Background(), &config.Config{}, delivery, testKimiID, true)
	if !started || result.MissingTranscript {
		t.Fatalf("existing session was rejected: %+v", result)
	}
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkKimiTranscript(testKimiID); err == nil || errors.Is(err, errNativeTranscriptMissing) {
		t.Fatal("corrupt session classified as missing", err)
	}
}
func TestKimiPersistentAuthNeverUploadsPrivateProjection(t *testing.T) {
	old := runPersistentAuthCommand
	t.Cleanup(func() { runPersistentAuthCommand = old })
	runPersistentAuthCommand = func(context.Context, string, string) error {
		t.Fatal("Kimi auth watcher attempted canonical upload")
		return nil
	}
	runPersistentAuthWatch(context.Background(), "kimi", nil)
}

func TestKimiNativeSwitchCannotReleaseOrClaimFromPreviousTranscript(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "kimi")
	var acks int
	c := &sessionClient{id: "launch", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{}`
		if strings.HasSuffix(req.URL.Path, "/receiver/native") {
			body = `{"native_session_id":"session_22222222-2222-4222-8222-222222222222"}`
		} else if strings.HasSuffix(req.URL.Path, "/ack") {
			acks++
		} else {
			t.Errorf("unexpected request %s", req.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	tracker := newChannelTracker(c)
	r := &autoReceiver{client: c, tracker: tracker, connected: true, lastBeatOK: time.Now(), sources: []string{"peer"}, boundNativeID: testKimiID}
	tracker.receiver = r
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracker.track(ctx, "old-message", "original-claim")
	if _, err := agentListen(ctx, c, tracker, map[string]any{}); err == nil || !strings.Contains(err.Error(), "native session changed") {
		t.Fatal("different transcript consumed a delivery", err)
	}
	if tracker.get("old-message") == nil || acks != 0 {
		t.Fatal("old receipt released by an unseen transcript")
	}
	if err := r.rebindKimiNative(ctx, "session_22222222-2222-4222-8222-222222222222"); err != nil {
		t.Fatal(err)
	}
	if tracker.get("old-message") != nil || acks != 1 {
		t.Fatal("old ownership was not retired on rebind")
	}
}

func TestKimiBrokenSessionStoreNeverAuthorizesReplacement(t *testing.T) {
	home := t.TempDir()
	t.Setenv("KIMI_CODE_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "sessions"), []byte("broken store"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkKimiTranscript(testKimiID); err == nil || errors.Is(err, errNativeTranscriptMissing) {
		t.Fatal("broken store misclassified as a missing transcript", err)
	}
}

func TestKimiPromptByteBound(t *testing.T) {
	for _, prompt := range []string{strings.Repeat("a", 100000), strings.Repeat("é", 50000), strings.Repeat("😀", 25000)} {
		if err := checkKimiPrompt(prompt); err != nil {
			t.Fatal(err)
		}
		if err := checkKimiPrompt(prompt + "a"); err == nil {
			t.Fatal("oversize UTF-8 prompt accepted")
		}
	}
}

func TestKimiWorkersRejectOversizeArgvBeforeExec(t *testing.T) {
	content := strings.Repeat("界", 40000)
	result := (&relayClient{}).runNative(context.Background(), &config.Config{}, &relayDelivery{
		Target: map[string]any{"engine": "kimi"}, Content: content,
	}, "", false)
	if result.Err == nil || result.Err.Error() != "Kimi prompt exceeds 100000 UTF-8 bytes" {
		t.Fatalf("relay result: %+v", result)
	}
	daemon := runDaemonOperation(context.Background(), daemonOperation{Engine: "kimi", Cwd: t.TempDir(), Prompt: content})
	if daemon.Status != "failed" || daemon.Reply != "Kimi prompt exceeds 100000 UTF-8 bytes" {
		t.Fatalf("daemon result: %+v", daemon)
	}
}
