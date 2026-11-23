package launchupdate

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	claudeorchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestForegroundCheckOnOldConfigOrPendingRelease(t *testing.T) {
	now := time.Now()
	cfg := &config.Config{IssuedAt: now.Format(time.RFC3339), Wrapper: config.Wrapper{Version: "0.9.203"}}
	if due(cfg, "0.9.203", now) || !due(cfg, "0.9.202", now) {
		t.Fatal("fresh config should only trigger an immediate probe for a newer release")
	}
	cfg.IssuedAt = now.Add(-staleAfter).Format(time.RFC3339)
	if !due(cfg, "0.9.203", now) {
		t.Fatal("old config may have missed a release")
	}
}

func TestCacheFailureOnlyArmsRecoveryForCommunicatorErrors(t *testing.T) {
	for _, err := range []error{
		&orchestrator.HTTPError{StatusCode: http.StatusConflict, Code: "communicator_outcome_unknown"},
		&claudeorchestrator.HTTPError{StatusCode: http.StatusServiceUnavailable, Code: "communicator_unavailable"},
	} {
		attempt := &launchAttempt{}
		ctx := context.WithValue(context.Background(), launchKey{}, attempt)
		wrapped := CacheFailure(ctx, errors.Join(errors.New("other resource failed"), err))
		if !errors.Is(wrapped, err) || !attempt.cacheFailure {
			t.Fatalf("communicator error was not preserved and recorded: %v", wrapped)
		}
	}
	if recoverable(&orchestrator.HTTPError{StatusCode: http.StatusForbidden, Code: "host_insecure"}) {
		t.Fatal("host approval cannot trigger a wrapper update retry")
	}
}

func TestOnlyNewerOfferedSignedTargetCanInstall(t *testing.T) {
	digest := strings.Repeat("a", 64)
	cfg := &config.Config{Wrapper: config.Wrapper{Version: "0.9.203", BinarySHA256: digest, BinaryURL: "/wrapper/v2/bin/cxx"}}
	for _, tt := range []struct {
		name, action, target, digest string
		wantInstall, wantErr         bool
	}{
		{"signed update", "no_update", "0.9.203", digest, true, false},
		{"disabled", "disable", "0.9.203", digest, false, false},
		{"malformed response", "", "0.9.203", digest, false, true},
		{"downgrade", "no_update", "0.9.201", digest, false, false},
		{"wrong version", "no_update", "0.9.204", digest, false, true},
		{"wrong digest", "no_update", "0.9.203", strings.Repeat("b", 64), false, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			check := &orchestrator.CronCheckResponse{
				Action:  tt.action,
				Wrapper: &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: tt.target, SHA256: tt.digest},
			}
			target, err := verifyTarget(cfg, check, "0.9.202")
			if (target != nil) != tt.wantInstall || (err != nil) != tt.wantErr {
				t.Fatalf("target=%+v err=%v", target, err)
			}
		})
	}
}

func TestReleaseProbeUsesConfiguredTLSAndDoesNotRequireAnOwner(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var body orchestrator.CronCheckRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode update probe: %v", err)
		}
		if r.Method != http.MethodPost || r.URL.Path != "/cron/check" || r.Header.Get("X-API-Key") != "fixture-key" ||
			!body.Probe || body.Engine != config.EngineKimi || body.WrapperVersion != "0.9.202" {
			t.Errorf("unexpected update probe %s %s %+v", r.Method, r.URL.Path, body)
		}
		_, _ = w.Write([]byte(`{"action":"no_update"}`))
	}))
	defer srv.Close()

	cfg := &config.Config{Engine: config.EngineKimi, Orchestrator: config.Orchestrator{BaseURL: srv.URL, APIKey: "fixture-key"}}
	if _, err := checkRelease(context.Background(), cfg, "0.9.202"); !errors.As(err, new(x509.UnknownAuthorityError)) {
		t.Fatalf("untrusted TLS probe error = %v", err)
	}
	caPath := filepath.Join(t.TempDir(), "root.pem")
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	if err := os.WriteFile(caPath, ca, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.Orchestrator.CABundlePath = &caPath
	probe, err := checkRelease(context.Background(), cfg, "0.9.202")
	if err != nil || probe.Action != "no_update" || requests.Load() != 1 {
		t.Fatalf("probe=%+v requests=%d err=%v", probe, requests.Load(), err)
	}
}

func TestRestartPreservesPersonaNativeGrammarAndArgs(t *testing.T) {
	exe := "/installed/cxx"
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok, config.EngineKimi} {
		alias := map[string]string{"codex": "cdx", "claude": "clx", "grok": "cgx", "kimi": "ckx"}[engine]
		for _, tt := range []struct{ original, want []string }{
			{[]string{alias, "--execute", "two words"}, []string{exe, engine, "--execute", "two words"}},
			{[]string{"cxx", "native", engine, "--", "--continue"}, []string{exe, "native", engine, "--", "--continue"}},
			{[]string{"cxx", engine, "resume"}, []string{exe, engine, "resume"}},
			{[]string{"cxx"}, []string{exe, engine}},
		} {
			if got := launchArgv(exe, engine, tt.original); !slices.Equal(got, tt.want) {
				t.Errorf("launchArgv(%q)=%q want %q", tt.original, got, tt.want)
			}
		}
	}
}
