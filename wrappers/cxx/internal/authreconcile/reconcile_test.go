package authreconcile

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func fixture(t *testing.T, engine string) (backend, []byte, serverAuth) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	b, err := forEngine(&config.Config{Engine: engine, Host: config.Host{Secure: true}})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(b.path), 0700); err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	oldStamp := time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339Nano)
	local := []byte(`{"last_refresh":"` + stamp + `","tokens":{"access_token":"local-fixture-secret","refresh_token":"fixture-refresh"}}`)
	remote := []byte(`{"last_refresh":"` + oldStamp + `","tokens":{"access_token":"server-fixture-secret","refresh_token":"fixture-refresh"}}`)
	if engine == "claude" {
		local = []byte(`{"last_refresh":"` + stamp + `","claudeAiOauth":{"accessToken":"local-fixture-secret","refreshToken":"fixture-refresh"}}`)
		remote = []byte(`{"last_refresh":"` + oldStamp + `","claudeAiOauth":{"accessToken":"server-fixture-secret","refreshToken":"fixture-refresh"}}`)
	}
	if err = os.WriteFile(b.path, local, 0600); err != nil {
		t.Fatal(err)
	}
	marker, _ := json.Marshal(map[string]string{"generation": digest(local)})
	if err = os.WriteFile(filepath.Join(filepath.Dir(b.path), ".cxx-communicator-pending-auth.json"), marker, 0600); err != nil {
		t.Fatal(err)
	}
	return b, local, serverAuth{Engine: engine, AccountID: 7, Verification: "verified", Digest: strings.Repeat("b", 64), Generation: 42, Auth: remote}
}

func TestExplicitRecoveryChoiceAndRaces(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		for _, scenario := range []string{"inspect", "accept_older", "accept_equal", "accept_malformed_marker", "insecure_config", "server_became_insecure", "unverified", "wrong_account", "wrong_engine", "binding_absent", "binding_change", "native_during_read", "native_after_backup", "logout_after_backup", "backup_failed", "write_failed", "marker_changed", "native_after_write", "active"} {
			t.Run(engine+"/"+scenario, func(t *testing.T) {
				b, local, s := fixture(t, engine)
				markerPath := filepath.Join(filepath.Dir(b.path), ".cxx-communicator-pending-auth.json")
				marker, _ := os.ReadFile(markerPath)
				if scenario == "accept_malformed_marker" {
					marker = []byte("{}")
					if err := os.WriteFile(markerPath, marker, 0600); err != nil {
						t.Fatal(err)
					}
				}
				calls, writes := 0, 0
				binding := int64(7)
				if scenario == "binding_absent" {
					binding = 0
				}
				tx := transaction{backend: b, backup: saveBackup, binding: func() int64 { return binding }}
				native := []byte(strings.Replace(string(local), "local-fixture-secret", "native-winner-secret", 1))
				tx.readback = func(context.Context, int64, string) (serverAuth, error) {
					calls++
					switch scenario {
					case "accept_equal":
						var doc map[string]any
						_ = json.Unmarshal(s.Auth, &doc)
						var localDoc map[string]any
						_ = json.Unmarshal(local, &localDoc)
						doc["last_refresh"] = localDoc["last_refresh"]
						s.Auth, _ = json.Marshal(doc)
					case "server_became_insecure":
						flag := false
						s.Host = &struct {
							Secure *bool `json:"secure"`
						}{Secure: &flag}
					case "unverified":
						s.Verification = "pending"
					case "wrong_account":
						s.AccountID = 99
					case "wrong_engine":
						s.Engine = "grok"
					case "binding_change":
						binding = 99
					case "native_during_read":
						if err := os.WriteFile(b.path, native, 0600); err != nil {
							t.Fatal(err)
						}
					}
					return s, nil
				}
				tx.backup = func(path string, raw []byte) (string, error) {
					if scenario == "backup_failed" {
						return "", errors.New("fixture failure")
					}
					backup, err := saveBackup(path, raw)
					if scenario == "native_after_backup" {
						if e := os.WriteFile(path, native, 0600); e != nil {
							t.Fatal(e)
						}
					}
					if scenario == "logout_after_backup" {
						if engine == "codex" {
							_, e := codex.MarkLogoutIntent(codex.AuthGeneration{Exists: true, Digest: digest(local)})
							if e != nil {
								t.Fatal(e)
							}
						} else {
							_, e := claude.RecordDeferredExplicitLogout(claude.AuthGeneration{Exists: true, Digest: digest(local)})
							if e != nil {
								t.Fatal(e)
							}
						}
					}
					return backup, err
				}
				tx.backend.apply = func(ctx context.Context, server serverAuth, generation string) (string, bool, error) {
					writes++
					if scenario == "write_failed" {
						return "", false, errors.New("fixture write failure")
					}
					adopted, wrote, err := b.apply(ctx, server, generation)
					if scenario == "marker_changed" {
						if e := os.WriteFile(markerPath, append(marker, ' '), 0600); e != nil {
							t.Fatal(e)
						}
					}
					if scenario == "native_after_write" {
						if e := os.WriteFile(b.path, native, 0600); e != nil {
							t.Fatal(e)
						}
					}
					return adopted, wrote, err
				}
				if scenario == "insecure_config" {
					tx.backend.secure = false
				}
				if scenario == "active" {
					tx.backend.active = func() (bool, error) { return true, nil }
				}
				report, err := tx.run(context.Background(), engine, "expired-lease-fixture", scenario != "inspect")
				if calls != 1 {
					t.Fatalf("readback effects=%d", calls)
				}
				encoded, _ := json.Marshal(report)
				if strings.Contains(string(encoded), "fixture-secret") || strings.Contains(string(encoded), "winner-secret") {
					t.Fatal("report leaked credential material")
				}
				if scenario != "active" && (!report.InactiveSessionOmitted || report.SessionID != "") {
					t.Fatal("inactive expired lease was submitted")
				}
				if scenario == "inspect" {
					if err != nil || writes != 0 || report.Backup != "" || report.Adopted {
						t.Fatalf("inspection had write effects: %v", err)
					}
				} else if scenario == "accept_older" || scenario == "accept_equal" || scenario == "accept_malformed_marker" {
					if err != nil || !report.Adopted || report.Reason != "server_credentials_adopted" || writes != 1 {
						t.Fatalf("explicit older choice failed: %+v err=%v", report, err)
					}
					if _, e := os.Stat(markerPath); !os.IsNotExist(e) {
						t.Fatal("matching fence not cleared")
					}
					backup, e := os.ReadFile(report.Backup)
					info, _ := os.Stat(report.Backup)
					if e != nil || string(backup) != string(local) || info.Mode().Perm() != 0600 {
						t.Fatal("backup is not exact private original")
					}
					return
				} else if err == nil {
					t.Fatalf("unsafe case succeeded: %+v", report)
				}
				latest, _ := os.ReadFile(markerPath)
				if scenario == "marker_changed" {
					if string(latest) != string(append(marker, ' ')) {
						t.Fatal("new marker removed")
					}
				} else if string(latest) != string(marker) {
					t.Fatal("unresolved marker changed")
				}
				raw, _ := os.ReadFile(b.path)
				if strings.HasPrefix(scenario, "native_") {
					if string(raw) != string(native) {
						t.Fatal("native winner lost")
					}
				} else if scenario != "marker_changed" && string(raw) != string(local) {
					t.Fatal("local credentials lost")
				}
				if report.Backup != "" {
					backup, _ := os.ReadFile(report.Backup)
					if string(backup) != string(local) {
						t.Fatal("failure backup lost original")
					}
				}
			})
		}
	}
}

func TestBackupsNeverFollowSymlinksOrOverwrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")
	a, err := saveBackup(path, []byte("first-fixture"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := saveBackup(path, []byte("second-fixture"))
	if err != nil || a == b {
		t.Fatal("backup reused path")
	}
	first, _ := os.ReadFile(a)
	if string(first) != "first-fixture" {
		t.Fatal("previous backup overwritten")
	}
	other := t.TempDir()
	target := filepath.Join(other, "auth-recovery-backups")
	if err = os.Symlink(filepath.Dir(a), target); err != nil {
		t.Fatal(err)
	}
	if _, err = saveBackup(filepath.Join(other, "auth.json"), []byte("third-fixture")); err == nil {
		t.Fatal("followed backup directory symlink")
	}
}
