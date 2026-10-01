package grok

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func runtimeFixture(t *testing.T) (*Runtime, *accountpool.Context) {
	t.Helper()
	home, err := os.MkdirTemp("/tmp", "cgx-unit-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv("HOME", home)
	t.Setenv("GROK_HOME", filepath.Join(home, "native"))
	t.Setenv("GROK_CONFIG", "")
	t.Setenv("GROK_CONFIG_PATH", "")
	base, _ := Home()
	pool := accountpool.Load("grok", filepath.Join(base, "auth.json"), "https://fixture.invalid")
	pool.AccountID, pool.SessionID, pool.Capable = 7001, "fixture-lease", true
	r, err := NewRuntime(base, &config.Config{}, nil, pool)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close() })
	return r, pool
}
func projectedFixture(token string, expires time.Time) json.RawMessage {
	doc := map[string]any{"grok_scope": OfficialScope, "grok_auth": map[string]any{OfficialScope: map[string]any{"key": token, "auth_mode": "external", "create_time": time.Now().UTC(), "expires_at": expires, "oidc_issuer": "https://auth.x.ai", "oidc_client_id": OfficialClientID}, "legacy": map[string]any{"auth_mode": "web_login", "user_id": "metadata-only"}}}
	raw, _ := json.Marshal(doc)
	return raw
}
func TestRuntimeProjectsAccessOnlyAndSharesOnlyNoncredentialPaths(t *testing.T) {
	r, _ := runtimeFixture(t)
	if err := AtomicWrite(filepath.Join(r.BaseHome, "auth.json"), []byte("original untouched fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(filepath.Join(r.BaseHome, "mcp_credentials.json"), []byte("original MCP fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(projectedFixture("access-fixture", time.Now().Add(time.Hour)), 17); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"auth.json", "mcp_credentials.json"} {
		if _, err := os.Lstat(filepath.Join(r.Home, name)); name == "mcp_credentials.json" && !os.IsNotExist(err) {
			t.Fatal("MCP credentials shared into runtime")
		}
	}
	link, err := os.Readlink(filepath.Join(r.Home, "sessions"))
	if err != nil || link != filepath.Join(r.BaseHome, "sessions") {
		t.Fatalf("native sessions not shared at root: %q,%v", link, err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(r.BaseHome, "auth.json"))
	if string(raw) != "original untouched fixture" {
		t.Fatal("unwrapped native auth changed")
	}
	if _, err := os.Stat(filepath.Join(r.BaseHome, "sessions")); err != nil {
		t.Fatal("shared history removed during cleanup")
	}
}

func TestRuntimeOriginalHomeMaintenanceGuard(t *testing.T) {
	r, _ := runtimeFixture(t)
	if guard, err := TryAcquireMaintenance(r.BaseHome); err != ipc.ErrHeld {
		if guard != nil {
			_ = guard.Release()
		}
		t.Fatalf("active runtime maintenance=%v", err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	guard, err := TryAcquireMaintenance(r.BaseHome)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Release()
	if _, err := NewRuntime(r.BaseHome, &config.Config{}, nil, r.Pool); err != ipc.ErrHeld {
		t.Fatalf("runtime bypassed maintenance=%v", err)
	}
}

func TestRuntimeLongHomeKeepsUnixSocketsPortable(t *testing.T) {
	home := filepath.Join(t.TempDir(), strings.Repeat("long-home-", 12))
	t.Setenv("HOME", home)
	base := filepath.Join(home, "native")
	pool := accountpool.Load("grok", filepath.Join(base, "auth.json"), "https://fixture.invalid")
	r, err := NewRuntime(base, &config.Config{}, nil, pool)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if len(r.Socket) >= 100 || len(filepath.Join(r.Dir, "grok.sock")) >= 100 {
		t.Fatal("native Unix socket path exceeds portable address limit")
	}
}
func TestProjectionRejectsRefreshMaterialAndForeignScope(t *testing.T) {
	for _, change := range []func(map[string]any){
		func(doc map[string]any) { doc["grok_scope"] = "https://foreign.invalid::client" },
		func(doc map[string]any) {
			doc["grok_auth"].(map[string]any)[OfficialScope].(map[string]any)["refresh_token"] = "refresh-fixture"
		},
		func(doc map[string]any) {
			doc["grok_auth"].(map[string]any)["legacy"].(map[string]any)["refresh_token"] = "refresh-fixture"
		},
		func(doc map[string]any) {
			doc["grok_auth"].(map[string]any)["legacy"].(map[string]any)["key"] = "foreign-access"
		},
		func(doc map[string]any) {
			doc["grok_auth"].(map[string]any)[OfficialScope].(map[string]any)["auth_mode"] = "api_key"
		},
	} {
		var doc map[string]any
		_ = json.Unmarshal(projectedFixture("access-fixture", time.Now().Add(time.Hour)), &doc)
		change(doc)
		raw, _ := json.Marshal(doc)
		if _, _, _, err := nativeProjection(raw); err == nil {
			t.Fatalf("invalid projection accepted: %T", change)
		}
	}
}
func TestRuntimePreservesUserOverlayAndPinsBrokerScope(t *testing.T) {
	r, _ := runtimeFixture(t)
	t.Setenv("GROK_CONFIG", `{"models":{"default":"grok-user"},"auth":{"oidc":{"issuer":"https://foreign.invalid","client_id":"foreign"}},"mcp_servers":{"mine":{"command":"my-tool"}}}`)
	if err := r.Configure("/path with spaces/cxx", &config.Config{}, true); err != nil {
		t.Fatal(err)
	}
	var effective map[string]any
	for _, entry := range r.Environment([]string{"XAI_API_KEY=discard", "GROK_OIDC_ISSUER=discard", "GROK_AUTH=discard", "GROK_AUTH_EXPIRED=1", "USER=fixture"}) {
		key, value, _ := strings.Cut(entry, "=")
		if key == "XAI_API_KEY" || key == "GROK_OIDC_ISSUER" || key == "GROK_AUTH" || key == "GROK_AUTH_EXPIRED" {
			t.Fatal("native auth fallback inherited")
		}
		if key == "GROK_CONFIG" {
			_ = json.Unmarshal([]byte(value), &effective)
		}
	}
	if effective["models"].(map[string]any)["default"] != "grok-user" {
		t.Fatal("user overlay lost")
	}
	if _, exists := effective["auth"]; exists {
		t.Fatal("custom auth alias survived managed pin")
	}
	gcc := effective["grok_com_config"].(map[string]any)
	if gcc["preferred_method"] != "oidc" || gcc["disable_api_key_auth"] != true || gcc["oauth2"].(map[string]any)["client_id"] != OfficialClientID {
		t.Fatal("managed native auth is not pinned")
	}
	servers := effective["mcp_servers"].(map[string]any)
	if servers["mine"] == nil || servers["cxx-agent"] == nil {
		t.Fatal("MCP merge lost user or managed server")
	}
}
func TestAuthAccessorUsesIssuedGenerationAndNeverUploads(t *testing.T) {
	r, pool := runtimeFixture(t)
	expires := time.Now().UTC().Add(time.Hour)
	if err := r.Apply(projectedFixture("access-old-fixture", expires), 17); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var requests []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		mu.Lock()
		requests = append(requests, body)
		mu.Unlock()
		if body["command"] != "retrieve" || body["engine"] != "grok" || body["account_id"] != float64(7001) || body["session_id"] != "fixture-lease" {
			t.Error("accessor request lost sticky account context")
		}
		generation := int64(17)
		token := "access-old-fixture"
		if body["refresh_if_generation"] != nil {
			generation, token = 18, "access-new-fixture"
			if body["refresh_if_generation"] != float64(17) {
				t.Error("refresh did not use the token's issued generation")
			}
		}
		_ = json.NewEncoder(w).Encode(Projection{Auth: projectedFixture(token, expires), AccountID: 7001, VerificationState: "verified", CanonicalGeneration: generation, AccessTokenDigest: tokenDigest(token), ExpiresAt: expires.Format(time.RFC3339Nano), AccountPool: true})
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	client.Pool = pool
	r.Client = client
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := r.StartAuthBroker(ctx); err != nil {
		t.Fatal(err)
	}
	t.Setenv(AuthSocketEnv, r.Socket)
	t.Setenv("GROK_AUTH_EXPIRED", "")
	var output, diagnostic bytes.Buffer
	if code := RunAuthAccessor(ctx, &output, &diagnostic); code != 0 {
		t.Fatalf("initial accessor failed: %s", diagnostic.String())
	}
	if strings.Contains(output.String(), "refresh_token") {
		t.Fatal("refresh material exposed")
	}
	t.Setenv("GROK_AUTH_EXPIRED", "1")
	output.Reset()
	diagnostic.Reset()
	if code := RunAuthAccessor(ctx, &output, &diagnostic); code != 0 {
		t.Fatalf("refresh accessor failed: %s", diagnostic.String())
	}
	var response map[string]any
	_ = json.Unmarshal(output.Bytes(), &response)
	if response["access_token"] != "access-new-fixture" {
		t.Fatal("successor not returned")
	}
	native, _ := os.ReadFile(r.AuthPath)
	if strings.Contains(string(native), "access-new-fixture") {
		t.Fatal("helper wrote native auth while native owns its file lock")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 2 || requests[0]["refresh_if_generation"] != nil || requests[1]["refresh_if_generation"] != float64(17) {
		t.Fatal("unexpected refresh request contract")
	}
	for _, body := range requests {
		if body["auth"] != nil || body["auth_candidate"] != nil {
			t.Fatal("runtime projection uploaded as canonical")
		}
	}
}
func TestAuthAccessorRejectsSameGenerationAndExpiredLease(t *testing.T) {
	r, pool := runtimeFixture(t)
	expires := time.Now().UTC().Add(time.Hour)
	if err := r.Apply(projectedFixture("access-fixture", expires), 17); err != nil {
		t.Fatal(err)
	}
	status := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if status != 200 {
			w.WriteHeader(status)
			return
		}
		_ = json.NewEncoder(w).Encode(Projection{Auth: projectedFixture("access-fixture", expires), AccountID: 7001, VerificationState: "verified", CanonicalGeneration: 17, AccessTokenDigest: tokenDigest("access-fixture"), ExpiresAt: expires.Format(time.RFC3339Nano)})
	}))
	defer server.Close()
	client, _ := orchestrator.New(orchestrator.Options{BaseURL: server.URL})
	client.Pool = pool
	r.Client = client
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := r.StartAuthBroker(ctx); err != nil {
		t.Fatal(err)
	}
	t.Setenv(AuthSocketEnv, r.Socket)
	t.Setenv("GROK_AUTH_EXPIRED", "1")
	for _, failure := range []int{200, 404, 503, 401} {
		status = failure
		var out, errout bytes.Buffer
		if code := RunAuthAccessor(ctx, &out, &errout); code == 0 || out.Len() != 0 {
			t.Fatalf("auth failure %d returned token", failure)
		}
	}
}

func TestHeartbeatFetchedHeadDoesNotBecomeNativeIssuedGeneration(t *testing.T) {
	r, pool := runtimeFixture(t)
	expires := time.Now().UTC().Add(time.Hour)
	if err := r.Apply(projectedFixture("held-generation17", expires), 17); err != nil {
		t.Fatal(err)
	}
	var observed int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		if n, ok := body["refresh_if_generation"].(float64); ok {
			observed = int64(n)
		}
		_ = json.NewEncoder(w).Encode(Projection{Auth: projectedFixture("canonical-generation18", expires), AccountID: 7001, VerificationState: "verified", CanonicalGeneration: 18, AccessTokenDigest: tokenDigest("canonical-generation18"), ExpiresAt: expires.Format(time.RFC3339Nano)})
	}))
	defer server.Close()
	client, _ := orchestrator.New(orchestrator.Options{BaseURL: server.URL})
	client.Pool = pool
	r.Client = client
	if err := r.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	native, _ := os.ReadFile(r.AuthPath)
	if strings.Contains(string(native), "canonical-generation18") {
		t.Fatal("heartbeat changed native cache before token issuance")
	}
	if len(r.issued) != 1 || r.issued[0].Generation != 17 {
		t.Fatal("heartbeat changed issued generation")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := r.StartAuthBroker(ctx); err != nil {
		t.Fatal(err)
	}
	t.Setenv(AuthSocketEnv, r.Socket)
	t.Setenv("GROK_AUTH_EXPIRED", "1")
	var out, errout bytes.Buffer
	if code := RunAuthAccessor(ctx, &out, &errout); code != 0 {
		t.Fatalf("reactive refresh failed: %s", errout.String())
	}
	if observed != 17 || !strings.Contains(out.String(), "canonical-generation18") {
		t.Fatalf("reactive refresh used fetched head: generation=%d", observed)
	}
}
