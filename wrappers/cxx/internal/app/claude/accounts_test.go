package claudeapp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

const enrollNative = `#!/bin/sh
# Fake native Claude: record the isolated config dir and write a login there.
printf '%s' "$CLAUDE_CONFIG_DIR" > "$ENROLL_RECORD"
[ "$1 $2" = "auth login" ] || exit 9
[ -n "$FAIL_LOGIN" ] && exit 3
printf '{"claudeAiOauth":{"accessToken":"second-access","refreshToken":"second-refresh","expiresAt":4102444800000}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
`

func enrollFixture(t *testing.T, handler http.HandlerFunc) (*config.Config, string, string, []byte) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "/must/not/leak")
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte(enrollNative), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	record := filepath.Join(t.TempDir(), "record")
	t.Setenv("ENROLL_RECORD", record)
	native := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(native), 0o700); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"claudeAiOauth":{"accessToken":"first-access","refreshToken":"first-refresh","expiresAt":4102444800000}}`)
	if err := os.WriteFile(native, original, 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	cfg := &config.Config{Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
	// The scope is bound to account 3 before enrollment.
	pool := accountpool.Load("claude", native, server.URL)
	pool.Observe("/auth", []byte(`{"account_id":3,"verification_state":"verified"}`))
	return cfg, home, record, original
}

func TestAccountsAddEnrollsInIsolatedDirectory(t *testing.T) {
	var body map[string]any
	cfg, home, record, original := enrollFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth" || r.Method != http.MethodPost {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		_, _ = w.Write([]byte(`{"status":"updated","account_id":5,"account_label":"b@example.com","account_created":true,"verification_state":"verified"}`))
	})
	nativeDir := filepath.Join(home, ".claude")
	before, _ := os.ReadDir(nativeDir)
	var stdout, stderr bytes.Buffer
	if code := accountsAdd(context.Background(), cfg, nil, &stdout, &stderr); code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "New account enrolled: #5 b@example.com") {
		t.Fatalf("output: %s", stdout.String())
	}
	if body["enroll"] != true || body["command"] != "store" || body["session_id"] != nil || body["account_id"] != nil {
		t.Fatalf("enroll body: %v", body)
	}
	auth, _ := body["auth"].(map[string]any)
	oauth, _ := auth["claudeAiOauth"].(map[string]any)
	if oauth["accessToken"] != "second-access" || auth["last_refresh"] == nil {
		t.Fatalf("uploaded payload: %v", auth)
	}
	// ~/.claude is byte-identical, its binding untouched, nothing added.
	raw, _ := os.ReadFile(filepath.Join(nativeDir, ".credentials.json"))
	if !bytes.Equal(raw, original) {
		t.Fatal("~/.claude/.credentials.json changed")
	}
	after, _ := os.ReadDir(nativeDir)
	if len(after) != len(before) {
		t.Fatalf("~/.claude entries changed: %v -> %v", before, after)
	}
	if bound := accountpool.Load("claude", filepath.Join(nativeDir, ".credentials.json"), cfg.Orchestrator.BaseURL).AccountID; bound != 3 {
		t.Fatalf("enrollment rebound the scope to %d", bound)
	}
	used, _ := os.ReadFile(record)
	root := filepath.Join(home, ".cxx", "claude-enroll")
	if !strings.HasPrefix(string(used), root+string(os.PathSeparator)) {
		t.Fatalf("native login ran with CLAUDE_CONFIG_DIR=%q", used)
	}
	if _, err := os.Stat(string(used)); !os.IsNotExist(err) {
		t.Fatal("enrollment directory not removed")
	}
	if info, err := os.Stat(root); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("enroll root: %v %v", info, err)
	}
}

func TestAccountsAddReportsUpdatedAccountAndCleansUpOnFailure(t *testing.T) {
	calls := 0
	cfg, home, record, _ := enrollFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"status":"updated","account_id":3,"account_label":"a@example.com","account_created":false,"verification_state":"verified"}`))
	})
	var stdout, stderr bytes.Buffer
	if code := accountsAdd(context.Background(), cfg, nil, &stdout, &stderr); code != 0 || !strings.Contains(stdout.String(), "Existing account refreshed: #3 a@example.com") {
		t.Fatalf("code=%d out=%s err=%s", code, stdout.String(), stderr.String())
	}
	t.Setenv("FAIL_LOGIN", "1")
	stdout.Reset()
	if code := accountsAdd(context.Background(), cfg, nil, &stdout, &stderr); code != 3 || calls != 1 {
		t.Fatalf("failed login: code=%d calls=%d", code, calls)
	}
	used, _ := os.ReadFile(record)
	if _, err := os.Stat(string(used)); !os.IsNotExist(err) {
		t.Fatal("enrollment directory kept after a failed login")
	}
	entries, _ := os.ReadDir(filepath.Join(home, ".cxx", "claude-enroll"))
	if len(entries) != 0 {
		t.Fatalf("leftover enrollment directories: %v", entries)
	}
}

func TestAccountsAddRefusesInsecureHost(t *testing.T) {
	cfg, _, record, _ := enrollFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"status":"error","code":"account_enroll_insecure_host","message":"Insecure hosts cannot enroll accounts"}`))
	})
	var stdout, stderr bytes.Buffer
	cfg.Host.Secure = false
	if code := accountsAdd(context.Background(), cfg, nil, &stdout, &stderr); code != 1 {
		t.Fatalf("insecure host code=%d", code)
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatal("native login ran on an insecure host")
	}
	// A host whose secure flag is stale still gets the server's refusal.
	cfg.Host.Secure = true
	if code := accountsAdd(context.Background(), cfg, nil, &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), "Insecure hosts cannot enroll accounts") {
		t.Fatalf("server refusal: %s", stderr.String())
	}
}

func TestAccountsUseRequiresLiveSession(t *testing.T) {
	var requests []map[string]any
	cfg, _, _, _ := enrollFixture(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		requests = append(requests, body)
		_, _ = w.Write([]byte(`{"bound_account_id":3,"binding_generation":2,"account_switch":{"account_id":5,"account_label":"b@example.com","binding_generation":2,"reason":"host"}}`))
	})
	t.Setenv("CXX_PROVIDER_SESSION_ID", "")
	var stdout, stderr bytes.Buffer
	if code := accountsUse(context.Background(), cfg, []string{"5"}, &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), "no running session in this scope") || len(requests) != 0 {
		t.Fatalf("no session: code=%d err=%s", code, stderr.String())
	}
	t.Setenv("CXX_PROVIDER_SESSION_ID", "abcdef0123")
	if code := accountsUse(context.Background(), cfg, []string{"5"}, &stdout, &stderr); code != 0 || !strings.Contains(stdout.String(), "switch to #5 b@example.com requested") {
		t.Fatalf("use: code=%d out=%s err=%s", code, stdout.String(), stderr.String())
	}
	if b := requests[0]; b["session_id"] != "abcdef0123" || b["account_id"] != float64(5) || b["reason"] != "host" {
		t.Fatalf("switch-request body: %v", b)
	}
}

func TestPrintAccountsMarksBindingAndRecommendation(t *testing.T) {
	var view accountsView
	raw := `{"engine":"claude","policy":{"mode":"auto","strategy":"balanced","spread":"normal","spread_points":20,"soft_ceiling":90,"hard_ceiling":99,"min_dwell_minutes":15},
	"bound_account_id":3,"binding_generation":2,"account_switch":null,
	"accounts":[{"id":3,"label":"a@x.de","email":"a@x.de","state":"enabled","verified":true,"plan":"Max 20x","short_used_percent":12,"weekly_used_percent":40,"active_sessions":2},
	{"id":7,"label":"b@x.de","email":null,"state":"paused","verified":false,"plan":null,"short_used_percent":null,"weekly_used_percent":null,"active_sessions":0}],
	"recommendation":{"action":"continue","account_id":null,"message":"Pool has headroom; keep working."}}`
	if err := json.Unmarshal([]byte(raw), &view); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	printAccounts(&out, view, 0)
	text := out.String()
	for _, want := range []string{"Policy: auto · balanced · band normal (20 points)", "*  3", "12 %", "40 %", "Max 20x", "Bound: #3 (generation 2)", "Recommendation (continue): Pool has headroom; keep working."} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
}
