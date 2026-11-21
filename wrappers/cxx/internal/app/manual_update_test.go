package app_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestDirectUpdateReportsTargetSource(t *testing.T) {
	const version = "0.9.192"
	root := t.TempDir()
	hostname, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	key := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	build := exec.Command("go", "build", "-o", filepath.Join(root, "cxx"), "-ldflags", "-X main.Version="+version+" -X github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing.buildPublicKeyB64="+key, "./cmd/cxx")
	build.Dir = "../.."
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v: %s", err, out)
	}
	for engine, alias := range map[string]string{"codex": "cdx", "claude": "clx", "grok": "cgx", "kimi": "ckx"} {
		if err := os.Symlink("cxx", filepath.Join(root, alias)); err != nil {
			t.Fatal(err)
		}
		t.Run(alias, func(t *testing.T) {
			usesAuthTarget := engine == "codex" || engine == "claude"
			checks := []string{"denied"}
			if usesAuthTarget {
				checks = append(checks, "missing target", "confirmed")
			}
			for _, check := range checks {
				t.Run(check, func(t *testing.T) {
					live := check == "confirmed"
					home := t.TempDir()
					var lookups atomic.Int32
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if (usesAuthTarget && r.URL.Path == "/auth") || (!usesAuthTarget && r.URL.Path == "/cron/check") {
							if lookups.Add(1) == 1 {
								switch check {
								case "confirmed":
									fmt.Fprintf(w, `{"status":"valid","versions":{"auto_update_enabled":true,"wrapper_version":"%s","wrapper_url":"http://%s/wrapper","wrapper_sha256":"%s"}}`, version, r.Host, strings.Repeat("0", 64))
									return
								case "missing target":
									fmt.Fprint(w, `{"status":"valid","versions":{}}`)
									return
								}
							}
						}
						w.WriteHeader(http.StatusForbidden)
						fmt.Fprint(w, `{"status":"error","code":"ip_mismatch","message":"fixture IP mismatch"}`)
					}))
					defer server.Close()
					cfg := config.Config{
						SchemaVersion: 1,
						Engine:        engine,
						IssuedAt:      "2026-01-01T00:00:00Z",
						Orchestrator:  config.Orchestrator{BaseURL: server.URL, APIKey: "fixture-key", InstallationID: "fixture"},
						Host:          config.Host{ID: 1, FQDN: hostname, Secure: true, EnginesList: []string{engine}},
						Wrapper:       config.Wrapper{Version: version, BinaryURL: server.URL + "/wrapper", BinarySHA256: strings.Repeat("0", 64)},
					}
					raw, err := json.Marshal(cfg)
					if err != nil {
						t.Fatal(err)
					}
					cfgPath := filepath.Join(home, alias+".json")
					if err = os.WriteFile(cfgPath, raw, 0600); err != nil {
						t.Fatal(err)
					}
					if err = os.WriteFile(cfgPath+".sig", ed25519.Sign(priv, raw), 0600); err != nil {
						t.Fatal(err)
					}
					ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
					defer cancel()
					cmd := exec.CommandContext(ctx, filepath.Join(root, alias), "--update")
					cmd.Env = []string{"HOME=" + home, "PATH=" + home, "XDG_RUNTIME_DIR=" + home, strings.ToUpper(alias) + "_CONFIG_PATH=" + cfgPath, "NO_COLOR=1"}
					out, err := cmd.CombinedOutput()
					if ctx.Err() != nil || err == nil || lookups.Load() == 0 {
						t.Fatalf("expected a failed maintenance step with a target lookup: %v, lookups %d:\n%s", err, lookups.Load(), out)
					}
					output := string(out)
					if live != strings.Contains(output, version+" up to date") || (!live && usesAuthTarget && !strings.Contains(output, "live target unconfirmed")) {
						t.Errorf("incorrect wrapper freshness for live=%v:\n%s", live, output)
					}
				})
			}
		})
	}
}
