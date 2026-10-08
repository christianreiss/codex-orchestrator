package agentbus

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// Explicit opt-in only: this checks the actual pinned binary with an operator-
// supplied access-only projection. All wrapper endpoints and receiver sources
// are local stubs; the single provider prompt asks for a fixed canary string.
func TestGrokNativeLeaderCanary(t *testing.T) {
	authFile, wrapper := os.Getenv("CXX_GROK_NATIVE_CANARY_AUTH"), os.Getenv("CXX_GROK_NATIVE_CANARY_WRAPPER")
	if authFile == "" || wrapper == "" {
		t.Skip("native canary requires explicit access-only auth and built wrapper")
	}
	binary, err := native.FindCLI()
	if err != nil {
		t.Fatal(err)
	}
	projection, err := os.ReadFile(authFile)
	if err != nil {
		t.Fatal("access-only canary projection unavailable")
	}
	var envelope struct {
		Scope string `json:"grok_scope"`
		Auth  map[string]struct {
			Key     string          `json:"key"`
			Expires time.Time       `json:"expires_at"`
			Refresh json.RawMessage `json:"refresh_token"`
		} `json:"grok_auth"`
	}
	if json.Unmarshal(projection, &envelope) != nil || envelope.Scope != native.OfficialScope {
		t.Fatal("invalid canary projection")
	}
	credential := envelope.Auth[envelope.Scope]
	if credential.Key == "" || !credential.Expires.After(time.Now().Add(time.Minute)) || len(credential.Refresh) > 0 {
		t.Fatal("canary must use current access-only credentials")
	}
	dir, err := os.MkdirTemp("/tmp", "cgx-live-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	t.Setenv("HOME", dir)
	t.Setenv("GROK_HOME", filepath.Join(dir, "native"))
	t.Setenv("GROK_CONFIG", "")
	t.Setenv("GROK_CONFIG_PATH", "")
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	if version, err := native.ProbeVersion(ctx, binary); err != nil || version != native.PinnedVersion {
		t.Fatal("native canary requires the pinned Grok binary")
	}
	var mu sync.Mutex
	requests, forced := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path != "/auth" || body["engine"] != "grok" || body["command"] != "retrieve" || body["account_id"] != float64(7001) || body["session_id"] != "canary-lease" {
			t.Error("canary auth broker lost fixed account lease")
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		requests++
		mu.Unlock()
		generation, access := int64(17), credential.Key
		auth := projection
		if observed, ok := body["refresh_if_generation"]; ok {
			mu.Lock()
			forced++
			attempt := forced
			mu.Unlock()
			if attempt == 1 {
				if observed != float64(17) {
					t.Error("native refresh lost issued generation17")
				}
				generation = 18
			} else {
				if observed != float64(18) {
					t.Error("reactive helper lost issued generation18")
				}
				generation, access = 19, "local-stub-successor"
				var doc map[string]any
				_ = json.Unmarshal(projection, &doc)
				doc["grok_auth"].(map[string]any)[native.OfficialScope].(map[string]any)["key"] = access
				auth, _ = json.Marshal(doc)
			}
		}
		sum := sha256.Sum256([]byte(access))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(native.Projection{Status: "valid", Auth: auth, AccountID: 7001, VerificationState: "verified", CanonicalGeneration: generation, AccessTokenDigest: hex.EncodeToString(sum[:]), ExpiresAt: credential.Expires.Format(time.RFC3339Nano), AccountPool: true})
	}))
	defer server.Close()
	base, _ := native.Home()
	pool := accountpool.Load("grok", filepath.Join(base, "auth.json"), server.URL)
	pool.AccountID, pool.SessionID, pool.Capable = 7001, "canary-lease", true
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client(), Pool: pool}
	cfg := &config.Config{Engine: config.EngineGrok, Host: config.Host{Secure: true}, EngineOptions: config.EngineOptions{ModelOverride: canaryString("grok-4.6"), ReasoningEffortOverride: canaryString("low")}}
	runtime, err := native.NewRuntime(base, cfg, client, pool)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if err := runtime.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	if err := runtime.StartAuthBroker(ctx); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Configure(wrapper, cfg, true); err != nil {
		t.Fatal(err)
	}
	portalSocket := filepath.Join(dir, "portal.sock")
	listener, err := net.Listen("unix", portalSocket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	nativeID, protocol := "", ""
	heartbeats := 0
	verifyDeliveries := os.Getenv("CXX_GROK_NATIVE_CANARY_DELIVERIES") == "1"
	deliverSources := false
	claimed, replied := map[string]bool{}, map[string]bool{}
	receiverGeneration := ""
	reconnectRequested, receiverReconnected := false, false
	peerID, portalID := newUUID(), newUUID()
	peerReceipt, portalReceipt := "CXX_PEER_"+newUUID(), "CXX_PORTAL_"+newUUID()
	portal := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		response := map[string]any{}
		responseStatus := http.StatusOK
		mu.Lock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/receiver/native"):
			// Production uses POST both to report and to read native identity.
			// An empty read must not erase a SessionStart report that won the race.
			if id := stringArg(body, "native_session_id"); id != "" {
				nativeID = id
			}
			response["native_session_id"] = nativeID
		case strings.HasSuffix(r.URL.Path, "/receiver/register"):
			protocol = stringArg(body, "protocol")
			generation := stringArg(body, "generation")
			if receiverGeneration != "" {
				if !reconnectRequested || generation == receiverGeneration {
					t.Error("receiver reconnect lost its generation fence")
				}
				receiverReconnected = true
				claimed, replied = map[string]bool{}, map[string]bool{}
				peerID, portalID = newUUID(), newUUID()
				peerReceipt, portalReceipt = "CXX_PEER_"+newUUID(), "CXX_PORTAL_"+newUUID()
			}
			receiverGeneration = generation
			if nativeID != "" && stringArg(body, "native_session_id") != nativeID {
				t.Error("hook and ACP identity differ")
			}
			response["sources"] = []string{}
		case strings.HasSuffix(r.URL.Path, "/receiver/heartbeat"):
			heartbeats++
			if verifyDeliveries && replied["peer"] && replied["portal"] && !reconnectRequested {
				reconnectRequested = true
				responseStatus = http.StatusConflict
				response["code"] = "receiver_generation_changed"
				response["message"] = "canary reconnect requested"
			}
			sources := []any{}
			if deliverSources {
				sources = []any{map[string]any{"source": "peer"}, map[string]any{"source": "portal"}}
			}
			response["receiver"] = map[string]any{"sources": sources}
		case strings.HasSuffix(r.URL.Path, "/receiver/claim"):
			source := stringArg(body, "source")
			if deliverSources && !claimed[source] {
				claimed[source] = true
				if source == "peer" {
					response["delivery"] = map[string]any{"message_id": peerID, "kind": "request", "content": "Call agent_reply with message_id " + peerID + " and content exactly " + peerReceipt + ". Do not use other tools."}
				} else if source == "portal" {
					response["message"] = map[string]any{"message_id": portalID, "lease_owner": "canary", "content": "Call agent_receiver_reply with message_id " + portalID + ", content exactly " + portalReceipt + " and summary Canary completed. Do not use other tools."}
				}
			}
		case strings.HasSuffix(r.URL.Path, "/agent-messaging/reply"):
			if stringArg(body, "message_id") != peerID || stringArg(body, "content") != peerReceipt {
				t.Error("native peer reply lost exact correlation")
			} else {
				replied["peer"] = true
			}
		case strings.HasSuffix(r.URL.Path, "/events"):
			payload, _ := body["payload"].(map[string]any)
			if stringArg(payload, "message_id") != portalID || stringArg(payload, "text") != portalReceipt {
				t.Error("native portal reply lost exact correlation")
			} else {
				replied["portal"] = true
			}
		case strings.HasSuffix(r.URL.Path, "/ack"):
			if stringArg(body, "outcome") == "accepted" {
				if strings.Contains(r.URL.Path, "/agent-commands/") {
					response["status"] = "accepted"
				} else {
					response["message"] = map[string]any{"status": "accepted"}
				}
			}
		case strings.HasSuffix(r.URL.Path, "/receiver/status"):
			if protocol != "" {
				response["receiver"] = map[string]any{"protocol": protocol, "native_session_id": nativeID}
			}
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(responseStatus)
		_ = json.NewEncoder(w).Encode(response)
	})}
	go portal.Serve(listener)
	defer portal.Close()
	socket := filepath.Join(runtime.Dir, "grok.sock")
	env := runtime.Environment(os.Environ())
	for key, value := range map[string]string{"CXX_GROK_SOCKET": socket, envSocket: portalSocket, envSessionID: "70010000-0000-4000-8000-000000000001", "CXX_AGENT_PORTAL_ENGINE": "grok"} {
		env = native.SetEnv(env, key, value)
	}
	firstHelper := exec.CommandContext(ctx, wrapper, "grok-auth")
	firstHelper.Env = env
	if _, err := firstHelper.Output(); err != nil {
		if failure, ok := err.(*exec.ExitError); ok {
			t.Fatalf("initial helper accessor failed: %s", strings.ReplaceAll(string(failure.Stderr), credential.Key, "<access-token>"))
		}
		t.Fatal("initial helper accessor failed:", err)
	}
	// Expire only the managed cache metadata. The real provider access token is
	// unchanged; the local stub serves generation18 with its actual fresh expiry.
	cache, err := os.ReadFile(runtime.AuthPath)
	if err != nil {
		t.Fatal(err)
	}
	var expired map[string]map[string]any
	_ = json.Unmarshal(cache, &expired)
	expired[native.OfficialScope]["expires_at"] = time.Now().Add(-time.Hour).UTC()
	cache, _ = json.Marshal(expired)
	if err := native.AtomicWrite(runtime.AuthPath, cache, 0o600); err != nil {
		t.Fatal(err)
	}
	leader := exec.CommandContext(ctx, binary, "agent", "leader", "--leader-socket", socket, "--relay-on-demand", "--no-auto-update")
	leader.Env, leader.Dir = env, dir
	var logs canaryLog
	defer func() {
		if t.Failed() {
			logs.mu.Lock()
			detail := strings.ReplaceAll(logs.b.String(), credential.Key, "<access-token>")
			logs.mu.Unlock()
			if len(detail) > 3000 {
				detail = detail[len(detail)-3000:]
			}
			t.Log("native canary diagnostic:", detail)
		}
	}()
	leader.Stdout, leader.Stderr = &logs, &logs
	if err := leader.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = leader.Process.Kill(); _ = leader.Wait() }()
	for deadline := time.Now().Add(15 * time.Second); ; {
		if _, err := os.Stat(socket); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native leader socket did not become ready")
		}
		time.Sleep(50 * time.Millisecond)
	}
	driver, err := openGrokQueue(ctx, socket, "")
	if err != nil {
		t.Fatal(err)
	}
	defer driver.close()
	var initialized map[string]any
	if err := driver.call("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}, "clientInfo": map[string]any{"name": "cxx-canary", "version": "0.9.9"}}, &initialized); err != nil {
		t.Fatal(err)
	}
	var session struct {
		ID string `json:"sessionId"`
	}
	if err := canaryCall(driver, "session/new", map[string]any{"cwd": dir, "mcpServers": []any{}, "_meta": map[string]any{"model": "grok-4.6", "permissionMode": "plan"}}, &session, credential.Key); err != nil {
		t.Fatal(err)
	}
	if session.ID == "" {
		t.Fatal("native session identity missing")
	}
	mu.Lock()
	nativeRenewal := forced
	mu.Unlock()
	if nativeRenewal != 1 {
		t.Fatal("Rust auth loader did not invoke the actual provider helper for expired cache")
	}
	queue, err := openGrokQueue(ctx, socket, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer queue.close()
	if id, err := queue.identity(); err != nil || id != session.ID {
		list, rosterErr := queue.roster()
		var actual map[string]any
		_ = canaryCall(queue, "_x.ai/sessions/list", map[string]any{}, &actual, credential.Key)
		t.Fatalf("native roster failed to bind canary session: %v; roster=%+v; read=%v; actual=%+v", err, list, rosterErr, actual)
	}
	start := time.Now()
	if err := queue.send("canary-prompt", "Reply exactly CXX_GROK_ACP_OK. Do not call tools."); err != nil {
		t.Fatal(err)
	}
	admission := time.Since(start)
	_ = queue.conn.SetDeadline(time.Now().Add(45 * time.Second))
	var responseText strings.Builder
	complete := false
	for !complete {
		event, err := queue.readACP()
		if err != nil {
			t.Fatal("native canary response did not complete")
		}
		if params, ok := event["params"].(map[string]any); ok && stringArg(params, "sessionId") == session.ID {
			if update, ok := params["update"].(map[string]any); ok && stringArg(update, "sessionUpdate") == "agent_message_chunk" {
				if content, ok := update["content"].(map[string]any); ok {
					responseText.WriteString(stringArg(content, "text"))
				}
			}
		}
		if result, ok := event["result"].(map[string]any); ok && stringArg(result, "stopReason") == "end_turn" {
			complete = true
		}
		if event["error"] != nil {
			t.Fatal("native canary prompt failed")
		}
	}
	if strings.TrimSpace(responseText.String()) != "CXX_GROK_ACP_OK" {
		t.Fatal("native canary returned unexpected text")
	}
	for deadline := time.Now().Add(15 * time.Second); ; {
		mu.Lock()
		ready := nativeID == session.ID && protocol == "grok-acp-v1" && heartbeats > 0
		mu.Unlock()
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native hook/MCP automatic receiver did not become healthy")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if verifyDeliveries {
		mu.Lock()
		deliverSources = true
		mu.Unlock()
		_ = driver.conn.SetDeadline(time.Now().Add(60 * time.Second))
		for {
			mu.Lock()
			finished := receiverReconnected && replied["peer"] && replied["portal"]
			mu.Unlock()
			if finished {
				break
			}
			event, err := driver.readACP()
			if err != nil {
				mu.Lock()
				t.Logf("delivery state: claimed=%v replied=%v heartbeats=%d", claimed, replied, heartbeats)
				mu.Unlock()
				if state, stateErr := queue.status(); stateErr == nil {
					t.Logf("native activity=%s", state)
				}
				t.Fatal("automatic peer/portal delivery did not complete:", err)
			}
			if stringArg(event, "method") == "session/request_permission" {
				params, _ := event["params"].(map[string]any)
				tool, _ := params["toolCall"].(map[string]any)
				title := stringArg(tool, "title")
				if !canaryReceiptTool(title) {
					t.Fatalf("canary requested an unexpected tool: %s", title)
				}
				options, _ := params["options"].([]any)
				optionID := ""
				for _, candidate := range options {
					if option, ok := candidate.(map[string]any); ok && stringArg(option, "kind") == "allow_once" {
						optionID = stringArg(option, "optionId")
					}
				}
				if optionID == "" {
					t.Fatal("canary receipt tool has no single-use approval")
				}
				raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": event["id"], "result": map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": optionID}}})
				if err := driver.write(map[string]any{"type": "acp", "payload": string(raw)}); err != nil {
					t.Fatal(err)
				}
			}
		}
		t.Log("automatic native peer and portal deliveries produced exact correlated MCP replies before and after generation reconnect")
		if err := portal.Close(); err != nil {
			t.Fatal(err)
		}
		doctor := exec.CommandContext(ctx, wrapper, "agent", "doctor", "--json")
		doctor.Env = env
		doctorOutput, err := doctor.Output()
		if err != nil {
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 {
				t.Fatal("offline doctor failed", err)
			}
		}
		var offline struct {
			Receiver struct {
				State string `json:"state"`
			} `json:"receiver"`
		}
		if json.Unmarshal(doctorOutput, &offline) != nil || offline.Receiver.State != "unavailable" {
			t.Fatal("offline broker was not reported unavailable")
		}
		t.Log("offline native broker reports unavailable")
	}
	mu.Lock()
	count := requests
	mu.Unlock()
	if count < 2 {
		t.Fatal("native external provider did not execute the helper")
	}
	// Stop provider work before returning a synthetic successor from the stub.
	_ = leader.Process.Kill()
	before, _ := os.ReadFile(runtime.AuthPath)
	helper := exec.CommandContext(ctx, wrapper, "grok-auth")
	helper.Env = native.SetEnv(env, "GROK_AUTH_EXPIRED", "1")
	helperOutput, err := helper.Output()
	if err != nil {
		t.Fatal("actual reactive helper invocation failed")
	}
	var helperResult struct {
		Token   string          `json:"access_token"`
		Refresh json.RawMessage `json:"refresh_token"`
	}
	if json.Unmarshal(helperOutput, &helperResult) != nil || helperResult.Token != "local-stub-successor" || len(helperResult.Refresh) > 0 {
		t.Fatal("helper did not return access-only successor")
	}
	after, _ := os.ReadFile(runtime.AuthPath)
	if !bytes.Equal(before, after) {
		t.Fatal("helper changed native auth cache outside native ownership")
	}
	mu.Lock()
	renewals := forced
	mu.Unlock()
	if renewals != 2 {
		t.Fatal("native and reactive helpers did not each make one generation-conditioned request")
	}
	t.Logf("native1.0.46: Rust external renewal, SessionStart identity, MCP grok-acp-v1 heartbeat, ACP roster and exact-text prompt passed; admission=%s; native generation17->18 and reactive18->19 succeeded, no refresh grants or helper cache writes", admission.Round(time.Millisecond))
}

// Native ACP may display the short MCP tool name instead of its qualified name.
// This isolated canary approves only the two receipt tools in either spelling.
func canaryReceiptTool(title string) bool {
	switch title {
	case "cxx-agent__agent_reply", "cxx-agent__agent_receiver_reply", "agent_reply", "agent_receiver_reply":
		return true
	default:
		return false
	}
}

func TestCanaryReceiptToolNames(t *testing.T) {
	for _, title := range []string{"cxx-agent__agent_reply", "cxx-agent__agent_receiver_reply", "agent_reply", "agent_receiver_reply"} {
		if !canaryReceiptTool(title) {
			t.Errorf("receipt tool rejected: %s", title)
		}
	}
	for _, title := range []string{"", "shell", "agent_send", "other__agent_reply", "agent_reply shell"} {
		if canaryReceiptTool(title) {
			t.Errorf("unrelated tool approved: %s", title)
		}
	}
}

func canaryString(value string) *string { return &value }

func canaryCall(q *grokQueue, method string, params, out any, token string) error {
	_ = q.conn.SetDeadline(time.Now().Add(10 * time.Second))
	id, err := q.sendRPC(method, params)
	if err != nil {
		return err
	}
	for {
		event, err := q.readACP()
		if err != nil {
			return err
		}
		if stringArg(event, "id") != id || stringArg(event, "method") != "" {
			continue
		}
		if detail, ok := event["error"].(map[string]any); ok {
			return fmt.Errorf("native %s: %s", method, strings.ReplaceAll(stringArg(detail, "message"), token, "<access-token>"))
		}
		raw, _ := json.Marshal(event["result"])
		return json.Unmarshal(raw, out)
	}
}

type canaryLog struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *canaryLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, err := io.Copy(&l.b, bytes.NewReader(p))
	return len(p), err
}
