package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }

type recordedRequest struct {
	path string
	body map[string]any
}

func TestReadMessageBodyRequiresExplicitStdin(t *testing.T) {
	if _, err := readMessageBody(strings.NewReader("secret peer text"), false); err == nil {
		t.Fatal("message body was accepted without --stdin")
	}
	body, err := readMessageBody(strings.NewReader("secret peer text"), true)
	if err != nil {
		t.Fatalf("read stdin body: %v", err)
	}
	if body != "secret peer text" {
		t.Fatalf("body = %q", body)
	}
	if _, err := readMessageBody(strings.NewReader(strings.Repeat("x", maxBodyBytes+1)), true); err == nil {
		t.Fatal("oversize body was accepted")
	}
}

func TestMCPToolCatalogHasMessagingButNoPermissionRelay(t *testing.T) {
	raw := string(toolCatalogJSON())
	for _, name := range []string{"agent_list", "agent_send", "agent_request", "agent_wait", "agent_reply", "agent_message_get", "agent_cancel"} {
		if !strings.Contains(raw, `"name":"`+name+`"`) {
			t.Fatalf("tool catalog missing %s: %s", name, raw)
		}
	}
	if strings.Contains(strings.ToLower(raw), "permission") {
		t.Fatalf("tool catalog must not relay permissions: %s", raw)
	}
}

func TestWriterLockPathDoesNotExposeNativeSessionID(t *testing.T) {
	path, err := writerLockPath("claude", "native-session-with-sensitive-shape")
	if err != nil {
		t.Fatalf("writer lock path: %v", err)
	}
	if strings.Contains(path, "native-session") {
		t.Fatalf("writer lock path leaked native id: %s", path)
	}
	if !strings.Contains(path, "claude-") {
		t.Fatalf("writer lock path lost engine: %s", path)
	}
}

func TestServiceDefinitionsRunWorkerWithoutContentArguments(t *testing.T) {
	environment := map[string]string{
		"CDX_CONFIG_PATH": "/srv/codex configs/cdx.json",
		"CLX_CONFIG_PATH": "/srv/claude&configs/clx.json",
	}
	linux := renderSystemdUserUnit("/opt/cxx", "deadbeef", environment)
	darwin := renderLaunchAgent("/opt/cxx", "deadbeef", environment)
	for name, body := range map[string]string{"systemd": linux, "launchd": darwin} {
		if !strings.Contains(body, "agent") || !strings.Contains(body, "worker") || !strings.Contains(body, "--foreground") {
			t.Fatalf("%s service does not run foreground worker: %s", name, body)
		}
		if strings.Contains(body, "content") || strings.Contains(body, "message-id") {
			t.Fatalf("%s service carries delivery data in argv: %s", name, body)
		}
		for _, key := range []string{"CDX_CONFIG_PATH", "CLX_CONFIG_PATH"} {
			if !strings.Contains(body, key) {
				t.Fatalf("%s service omitted %s: %s", name, key, body)
			}
		}
	}
	if !strings.Contains(darwin, "/srv/claude&amp;configs/clx.json") {
		t.Fatalf("launchd config path was not XML escaped: %s", darwin)
	}
}

func TestSystemdInstallRestartsChangedDeploymentButNotUnchangedWorker(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd action is Linux-specific")
	}
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg"))
	t.Setenv("CDX_CONFIG_PATH", filepath.Join(root, "custom", "cdx.json"))
	t.Setenv("CLX_CONFIG_PATH", filepath.Join(root, "custom", "clx.json"))
	oldProcess := managedServiceProcess
	t.Cleanup(func() { managedServiceProcess = oldProcess })
	var calls [][]string
	managedServiceProcess = func(_ io.Writer, _ io.Writer, name string, args ...string) error {
		calls = append(calls, append([]string{name}, args...))
		return nil
	}
	if err := runSystemdAction("install", io.Discard, io.Discard); err != nil {
		t.Fatalf("install systemd service: %v", err)
	}
	wantCalls := [][]string{
		{"systemctl", "--user", "daemon-reload"},
		{"systemctl", "--user", "enable", "cxx-agent.service"},
		{"systemctl", "--user", "restart", "cxx-agent.service"},
	}
	if !reflect.DeepEqual(calls, wantCalls) {
		t.Fatalf("systemd install calls = %v, want %v", calls, wantCalls)
	}
	calls = nil
	if err := runSystemdAction("install", io.Discard, io.Discard); err != nil {
		t.Fatalf("idempotent systemd install: %v", err)
	}
	wantCalls = [][]string{
		{"systemctl", "--user", "daemon-reload"},
		{"systemctl", "--user", "enable", "cxx-agent.service"},
		{"systemctl", "--user", "start", "cxx-agent.service"},
	}
	if !reflect.DeepEqual(calls, wantCalls) {
		t.Fatalf("idempotent systemd calls = %v, want %v", calls, wantCalls)
	}
	path, err := servicePath()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	unit := string(raw)
	for _, path := range []string{os.Getenv("CDX_CONFIG_PATH"), os.Getenv("CLX_CONFIG_PATH")} {
		if !strings.Contains(unit, path) {
			t.Fatalf("systemd unit omitted config path %q: %s", path, unit)
		}
	}
}

func TestSystemdRemovePreservesUnitWhenStopFails(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd action is Linux-specific")
	}
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg"))
	path, err := servicePath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("unit"), 0o600); err != nil {
		t.Fatal(err)
	}
	oldProcess, oldMissing := managedServiceProcess, systemdUnitMissing
	t.Cleanup(func() {
		managedServiceProcess = oldProcess
		systemdUnitMissing = oldMissing
	})
	managedServiceProcess = func(_ io.Writer, _ io.Writer, _ string, _ ...string) error {
		return errors.New("systemctl unavailable")
	}
	systemdUnitMissing = func(string) (bool, error) { return false, nil }
	if err := runSystemdAction("remove", io.Discard, io.Discard); err == nil {
		t.Fatal("remove ignored a service stop failure")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("unit was removed after failed stop: %v", err)
	}
}

func TestClaudeChannelAcceptsThenCompletesOnlyAfterCorrelatedReply(t *testing.T) {
	const messageID = "11111111-1111-4111-8111-111111111111"
	const conversationID = "22222222-2222-4222-8222-222222222222"
	requests := []recordedRequest{}
	client := &sessionClient{id: "33333333-3333-4333-8333-333333333333"}
	client.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(req.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		requests = append(requests, recordedRequest{path: req.URL.Path, body: body})
		payload := map[string]any{}
		if strings.HasSuffix(req.URL.Path, "/deliveries/claim") {
			payload["delivery"] = map[string]any{
				"message_id": messageID, "conversation_id": conversationID,
				"content": "  preserve peer whitespace  ",
				"sender":  map[string]any{"address": "agent:sender"},
			}
		}
		encoded, _ := json.Marshal(payload)
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(encoded))}, nil
	})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	state := newChannelTracker(client)
	var notification bytes.Buffer
	if err := channelPumpOnce(ctx, client, &mcpWriter{w: &notification}, state); err != nil {
		t.Fatalf("channel pump: %v", err)
	}
	if !strings.Contains(notification.String(), `"content":"  preserve peer whitespace  "`) {
		t.Fatalf("channel notification changed content: %s", notification.String())
	}
	if got := ackOutcomes(requests); len(got) != 1 || got[0] != "accepted" {
		t.Fatalf("outcomes before reply = %v", got)
	}
	if _, err := callMCPTool(ctx, client, state, "agent_reply", map[string]any{
		"message_id": messageID,
		"content":    "reply",
	}); err != nil {
		t.Fatalf("agent_reply: %v", err)
	}
	if got := ackOutcomes(requests); len(got) != 2 || got[0] != "accepted" || got[1] != "completed" {
		t.Fatalf("outcomes after reply = %v", got)
	}
	var replyClientID string
	for _, req := range requests {
		if strings.HasSuffix(req.path, "/reply") {
			replyClientID, _ = req.body["client_message_id"].(string)
		}
	}
	if replyClientID == "" {
		t.Fatal("channel reply omitted stable client_message_id")
	}
}

func TestClaudeChannelWriteFailureIsAmbiguous(t *testing.T) {
	const messageID = "11111111-1111-4111-8111-111111111111"
	requests := []recordedRequest{}
	client := &sessionClient{id: "33333333-3333-4333-8333-333333333333"}
	client.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(req.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		requests = append(requests, recordedRequest{path: req.URL.Path, body: body})
		payload := map[string]any{}
		if strings.HasSuffix(req.URL.Path, "/deliveries/claim") {
			payload["delivery"] = map[string]any{
				"message_id":      messageID,
				"conversation_id": "22222222-2222-4222-8222-222222222222",
				"content":         "peer text",
				"sender":          map[string]any{"address": "agent:sender"},
			}
		}
		encoded, _ := json.Marshal(payload)
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(encoded))}, nil
	})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := channelPumpOnce(ctx, client, &mcpWriter{w: failingWriter{}}, newChannelTracker(client)); err == nil {
		t.Fatal("channel writer failure was ignored")
	}
	got := ackOutcomes(requests)
	if len(got) != 1 || got[0] != "ambiguous" {
		t.Fatalf("writer failure outcomes = %v", got)
	}
}

func TestClaudeChannelCapabilityNeverRelaysPermissions(t *testing.T) {
	response := handleMCPRequest(context.Background(), nil, mcpRequest{
		JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "initialize",
	}, true, nil)
	raw, _ := json.Marshal(response)
	text := string(raw)
	if !strings.Contains(text, "claude/channel") {
		t.Fatalf("channel capability missing: %s", text)
	}
	if strings.Contains(text, "claude/channel/permission") {
		t.Fatalf("permission relay capability advertised: %s", text)
	}
}

func TestClaudeChannelActivatesOnlyAfterInitializedNotification(t *testing.T) {
	newClient := func(requests *[]recordedRequest, mu *sync.Mutex) *sessionClient {
		client := &sessionClient{id: "33333333-3333-4333-8333-333333333333"}
		client.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			raw, _ := io.ReadAll(req.Body)
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			mu.Lock()
			*requests = append(*requests, recordedRequest{path: req.URL.Path, body: body})
			mu.Unlock()
			if strings.HasSuffix(req.URL.Path, "/deliveries/claim") {
				<-req.Context().Done()
				return nil, req.Context().Err()
			}
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
		})}
		return client
	}

	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}` + "\n"
	var before []recordedRequest
	var beforeMu sync.Mutex
	if err := runMCPProtocol(newClient(&before, &beforeMu), true, strings.NewReader(initialize), io.Discard, io.Discard); err != nil {
		t.Fatalf("MCP initialize: %v", err)
	}
	beforeMu.Lock()
	beforeCount := len(before)
	beforeMu.Unlock()
	if beforeCount != 0 {
		t.Fatalf("channel bound before initialized notification: %+v", before)
	}

	initialized := initialize + `{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n"
	var after []recordedRequest
	var afterMu sync.Mutex
	if err := runMCPProtocol(newClient(&after, &afterMu), true, strings.NewReader(initialized), io.Discard, io.Discard); err != nil {
		t.Fatalf("MCP initialized notification: %v", err)
	}
	afterMu.Lock()
	defer afterMu.Unlock()
	var receiveStates []bool
	for _, request := range after {
		if strings.HasSuffix(request.path, "/bind") {
			receiveStates = append(receiveStates, request.body["receive_capable"] == true)
		}
	}
	if !reflect.DeepEqual(receiveStates, []bool{true, false}) {
		t.Fatalf("channel bind states = %v, requests=%+v", receiveStates, after)
	}
}

func TestChannelPreviewRequiresSignedClaudePolicyShape(t *testing.T) {
	cfg := &config.Config{Engine: config.EngineClaude, AgentMessaging: config.AgentMessaging{Enabled: true, ChannelPreviewEnabled: true}}
	if !channelPreviewAllowed(config.EngineClaude, cfg) {
		t.Fatal("enabled Claude Channel policy was rejected")
	}
	if channelPreviewAllowed(config.EngineCodex, cfg) {
		t.Fatal("Codex lifecycle was allowed to activate Claude Channel")
	}
	cfg.AgentMessaging.ChannelPreviewEnabled = false
	if channelPreviewAllowed(config.EngineClaude, cfg) {
		t.Fatal("disabled Channel preview policy was ignored")
	}
}

func TestChannelRenewalRetainsCorrelationOnTransientFailure(t *testing.T) {
	if definitiveChannelRenewalError(errors.New("temporary network failure")) {
		t.Fatal("transport failure was treated as definitive lease loss")
	}
	if definitiveChannelRenewalError(&APIError{Status: http.StatusServiceUnavailable, Code: "temporary_unavailable"}) {
		t.Fatal("temporary API failure was treated as definitive lease loss")
	}
	if !definitiveChannelRenewalError(&APIError{Status: http.StatusConflict, Code: "agent_messaging_lease_lost"}) {
		t.Fatal("definitive lease loss was treated as transient")
	}
}

func TestSendRejectsMessageContentInArgvBeforeSocketAccess(t *testing.T) {
	var stdout, stderr bytes.Buffer
	secret := "must-not-enter-argv"
	code := RunCommand([]string{"send", "--to", "agent:peer", secret}, strings.NewReader("ignored"), &stdout, &stderr, "test")
	if code == 0 {
		t.Fatal("positional message body was accepted")
	}
	if strings.Contains(stderr.String(), secret) {
		t.Fatalf("message body echoed from argv: %s", stderr.String())
	}
}

func TestRequestValidationHappensBeforeMutation(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := RunCommand([]string{"request", "--to", "agent:peer", "--stdin", "--wait-seconds", "26"}, strings.NewReader("peer text"), &stdout, &stderr, "test")
	if code == 0 || !strings.Contains(stderr.String(), "--wait-seconds") {
		t.Fatalf("invalid wait was not rejected before socket access: code=%d stderr=%q", code, stderr.String())
	}
}

func TestReplyRejectsPositionalContentBeforeSocketAccess(t *testing.T) {
	var stdout, stderr bytes.Buffer
	secret := "must-not-enter-reply-argv"
	code := RunCommand([]string{"reply", "--message-id", "11111111-1111-4111-8111-111111111111", "--stdin", secret}, strings.NewReader("ignored"), &stdout, &stderr, "test")
	if code == 0 {
		t.Fatal("positional reply body was accepted")
	}
	if strings.Contains(stderr.String(), secret) {
		t.Fatalf("reply body echoed from argv: %s", stderr.String())
	}
}

func TestProtectedFilesAndInstanceIDRepairPermissions(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "nested", "state")
	if err := writeProtectedFile(path, []byte("first")); err != nil {
		t.Fatal(err)
	}
	assertMode(t, filepath.Dir(path), 0o700)
	assertMode(t, path, 0o600)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeProtectedFile(path, []byte("second")); err != nil {
		t.Fatal(err)
	}
	assertMode(t, path, 0o600)

	sharedParent := filepath.Join(root, "shared-parent")
	if err := os.Mkdir(sharedParent, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeProtectedFile(filepath.Join(sharedParent, "unit"), []byte("service")); err != nil {
		t.Fatal(err)
	}
	assertMode(t, sharedParent, 0o755)

	t.Setenv("HOME", root)
	agentDir := filepath.Join(root, ".cxx", "agent")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}
	instancePath := filepath.Join(agentDir, "instance-id")
	const instanceID = "44444444-4444-4444-8444-444444444444"
	if err := os.WriteFile(instancePath, []byte(instanceID+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := loadOrCreateInstanceID()
	if err != nil || got != instanceID {
		t.Fatalf("instance id = %q, %v", got, err)
	}
	assertMode(t, agentDir, 0o700)
	assertMode(t, instancePath, 0o600)
}

func TestNativeAdapterArgumentsKeepPeerContentOnStdin(t *testing.T) {
	for _, tc := range []struct {
		engine   string
		upstream string
		want     []string
	}{
		{
			engine: config.EngineCodex, upstream: "codex-session",
			want: []string{"codex", "--skip-boot", "run", "exec", "resume", "--json", "--skip-git-repo-check", "codex-session", "-"},
		},
		{
			engine: config.EngineCodex,
			want:   []string{"codex", "--skip-boot", "run", "exec", "--json", "--skip-git-repo-check", "-"},
		},
		{
			engine: config.EngineClaude, upstream: "claude-session",
			want: []string{"claude", "--skip-boot", "resume", "claude-session", "-p", "--output-format", "json"},
		},
		{
			engine: config.EngineClaude,
			want:   []string{"claude", "--skip-boot", "run", "-p", "--output-format", "json"},
		},
	} {
		got := nativeArgs(tc.engine, tc.upstream)
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("nativeArgs(%q, %q) = %v, want %v", tc.engine, tc.upstream, got, tc.want)
		}
		joined := strings.Join(got, " ")
		for _, forbidden := range []string{"peer secret", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-skip-permissions", "bypassPermissions"} {
			if strings.Contains(joined, forbidden) {
				t.Fatalf("native args contain forbidden value %q: %v", forbidden, got)
			}
		}
	}
	delivery := &relayDelivery{
		MessageID:      "11111111-1111-4111-8111-111111111111",
		ConversationID: "22222222-2222-4222-8222-222222222222",
		Content:        "peer secret",
		Sender:         map[string]any{"address": "agent:sender"},
	}
	if prompt := peerPrompt(delivery); !strings.Contains(prompt, "peer secret") {
		t.Fatalf("peer prompt omitted stdin content: %s", prompt)
	}
}

func TestMissingTranscriptRecognizesCurrentClaudeOutput(t *testing.T) {
	if !isMissingTranscript("No conversation found with session ID: 11111111-1111-4111-8111-111111111111") {
		t.Fatal("current Claude missing-conversation output was not recognized")
	}
	if !isMissingTranscript("ERROR: no rollout found for session id 11111111-1111-4111-8111-111111111111") {
		t.Fatal("Codex missing-rollout output was not recognized")
	}
}

func TestTailBufferRetainsFinalCodexEvent(t *testing.T) {
	final := `{"type":"item.completed","item":{"type":"agent_message","text":"final reply"}}`
	var output tailBuffer
	output.limit = 256
	_, _ = output.Write([]byte(strings.Repeat("x", 1024) + "\n" + final + "\n"))
	if strings.Contains(output.String(), strings.Repeat("x", 512)) {
		t.Fatal("tail buffer retained the discarded prefix")
	}
	reply, _ := parseNativeOutput(config.EngineCodex, output.Bytes())
	if reply != "final reply" {
		t.Fatalf("final reply = %q, buffer=%q", reply, output.String())
	}
}

func TestRelayHeartbeatContinuesWhileClaimIsBlocked(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	claimStarted := make(chan struct{})
	var startOnce sync.Once
	var heartbeats atomic.Int32
	client := &relayClient{
		id: "11111111-1111-4111-8111-111111111111", token: "relay-token", baseURL: "https://relay.invalid",
		heartbeatEvery: 5 * time.Millisecond,
	}
	client.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch {
		case strings.HasSuffix(req.URL.Path, "/heartbeat"):
			heartbeats.Add(1)
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
		case strings.HasSuffix(req.URL.Path, "/deliveries/claim"):
			startOnce.Do(func() { close(claimStarted) })
			<-req.Context().Done()
			return nil, req.Context().Err()
		default:
			return nil, errors.New("unexpected relay path")
		}
	})}
	done := make(chan error, 1)
	go func() { done <- client.poll(ctx, nil, io.Discard) }()
	select {
	case <-claimStarted:
	case <-time.After(time.Second):
		t.Fatal("relay claim did not start")
	}
	deadline := time.After(time.Second)
	for heartbeats.Load() < 2 {
		select {
		case <-deadline:
			t.Fatalf("heartbeats while claim blocked = %d", heartbeats.Load())
		case <-time.After(2 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("relay poll did not stop")
	}
}

func TestMissingTranscriptFallsBackFreshWithoutSecondAcceptance(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(filepath.Join(os.Getenv("HOME"), ".cxx", "agent", "locks"), 0o700); err != nil {
		t.Fatal(err)
	}
	type invocation struct {
		upstream        string
		alreadyAccepted bool
	}
	var invocations []invocation
	oldAdapter := runNativeAdapter
	t.Cleanup(func() { runNativeAdapter = oldAdapter })
	requests := []recordedRequest{}
	client := &relayClient{id: "55555555-5555-4555-8555-555555555555", token: "relay-token", baseURL: "https://relay.invalid"}
	client.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(req.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		requests = append(requests, recordedRequest{path: req.URL.Path, body: body})
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	runNativeAdapter = func(c *relayClient, ctx context.Context, _ *config.Config, delivery *relayDelivery, upstream string, alreadyAccepted bool) nativeResult {
		invocations = append(invocations, invocation{upstream: upstream, alreadyAccepted: alreadyAccepted})
		if !alreadyAccepted {
			if err := c.ack(ctx, delivery, "accepted", "", nil); err != nil {
				return nativeResult{Err: err}
			}
			return nativeResult{Started: true, MissingTranscript: true, Err: errors.New("transcript missing")}
		}
		return nativeResult{Started: true, Reply: "fresh reply", UpstreamSessionID: "fresh-session"}
	}
	delivery := &relayDelivery{
		MessageID:      "11111111-1111-4111-8111-111111111111",
		ConversationID: "22222222-2222-4222-8222-222222222222",
		ClaimID:        "33333333-3333-4333-8333-333333333333",
		Target: map[string]any{
			"engine":              config.EngineCodex,
			"address":             "agent:target",
			"cwd":                 os.Getenv("HOME"),
			"continuity":          "native",
			"upstream_session_id": "missing-session",
		},
	}
	if err := client.processDelivery(context.Background(), map[string]*config.Config{
		config.EngineCodex: {Engine: config.EngineCodex},
	}, delivery); err != nil {
		t.Fatalf("process delivery: %v", err)
	}
	wantInvocations := []invocation{{upstream: "missing-session"}, {alreadyAccepted: true}}
	if !reflect.DeepEqual(invocations, wantInvocations) {
		t.Fatalf("invocations = %+v, want %+v", invocations, wantInvocations)
	}
	if got := ackOutcomes(requests); !reflect.DeepEqual(got, []string{"accepted", "completed"}) {
		t.Fatalf("fallback outcomes = %v", got)
	}
	var replies int
	for _, req := range requests {
		if strings.HasSuffix(req.path, "/reply") {
			replies++
			if req.body["content"] != "fresh reply" {
				t.Fatalf("reply body = %+v", req.body)
			}
		}
	}
	if replies != 1 {
		t.Fatalf("reply calls = %d", replies)
	}
}

func ackOutcomes(requests []recordedRequest) []string {
	var out []string
	for _, item := range requests {
		if strings.HasSuffix(item.path, "/ack") {
			outcome, _ := item.body["outcome"].(string)
			out = append(out, outcome)
		}
	}
	return out
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %o, want %o", path, got, want)
	}
}
