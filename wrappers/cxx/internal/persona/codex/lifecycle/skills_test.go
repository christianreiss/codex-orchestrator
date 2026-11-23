package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/summary"
)

func TestBootstrapReconcilesCodexSkillEntries(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	skillsRoot := filepath.Join(home, ".agents", "skills")
	local := filepath.Join(skillsRoot, "local", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(local, []byte("user-owned"), 0o644); err != nil {
		t.Fatal(err)
	}
	const manifest = "---\nname: fleet-example\ndescription: Fixture\n---\nRead skill://fleet.example.\n"
	const policy = "policy:\n  allow_implicit_invocation: false\n"
	manifestDigest := fmt.Sprintf("%x", sha256.Sum256([]byte(manifest)))
	policyDigest := fmt.Sprintf("%x", sha256.Sum256([]byte(policy)))
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte("SKILL.md\x00"+manifestDigest+"\nagents/openai.yaml\x00"+policyDigest+"\n")))
	step := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var payload orchestrator.BundleRequest
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil || !payload.CodexSkillEntries || payload.IncludeAuth {
			t.Errorf("bootstrap payload = %+v, decode error = %v", payload, err)
		}
		response := map[string]any{"status": "ok"}
		switch <-step {
		case "first", "repair":
			wanted := []map[string]any{{
				"slug": "fleet-example", "status": "updated", "sha256": digest, "content": manifest, "manifest_sha256": manifestDigest,
				"files": []map[string]string{{"path": "agents/openai.yaml", "content": policy, "sha256": policyDigest}},
			}, {"slug": "local", "status": "updated"}}
			if _, sent := payload.Skills["fleet-example"]; sent {
				t.Error("advertised a missing or damaged entry")
			}
			response["codex_skills"] = wanted
		case "unchanged":
			if payload.Skills["fleet-example"] != digest {
				t.Errorf("installed entry digest = %q, want %q", payload.Skills["fleet-example"], digest)
			}
			response["codex_skills"] = []map[string]string{{"slug": "fleet-example", "status": "unchanged", "sha256": digest}}
		case "disabled":
			response["codex_skills"] = []any{}
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": response}); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	policyPath := filepath.Join(skillsRoot, "fleet-example", "agents", "openai.yaml")
	authPath := filepath.Join(home, ".codex", "auth.json")
	for _, stage := range []struct {
		name                      string
		checked, updated, warning bool
	}{
		{"first", true, true, true},
		{"unchanged", true, false, false},
		{"omitted", false, false, false},
		{"repair", true, true, true},
		{"disabled", true, true, false},
	} {
		t.Run(stage.name, func(t *testing.T) {
			if stage.name == "repair" {
				if err := os.Remove(policyPath); err != nil {
					t.Fatal(err)
				}
			}
			step <- stage.name
			var got summary.ResourceSync
			_, err, _, _, _, _ := bootstrapWithProgress(context.Background(), client, logger, false, authPath, false, nil, nil, &got)
			if err != nil || got.Err != nil || got.Checked != stage.checked || got.Updated != stage.updated || (len(got.Warnings) > 0) != stage.warning {
				t.Fatalf("bootstrap = %+v, %v", got, err)
			}
			if raw, err := os.ReadFile(local); err != nil || string(raw) != "user-owned" {
				t.Fatalf("local entry changed: %q, %v", raw, err)
			}
			raw, err := os.ReadFile(policyPath)
			if stage.name == "disabled" {
				if !os.IsNotExist(err) {
					t.Fatalf("fleet entry was not removed: %v", err)
				}
			} else if err != nil || string(raw) != policy {
				t.Fatalf("fleet entry policy = %q, %v", raw, err)
			}
		})
	}
}

func TestSyncSkillsReportsListFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"unavailable"}`, http.StatusBadRequest)
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	got := syncSkills(context.Background(), client, logger)
	if !got.Checked || got.Err == nil || got.Updated {
		t.Fatalf("syncSkills failure = %+v, want checked warning", got)
	}
}

func TestSyncSkillsReportsSuccessfulUnchanged(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"skills":[{"slug":"git","sha256":"abc"}]}`)
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	if first := syncSkills(context.Background(), client, logger); first.Err != nil || !first.Updated {
		t.Fatalf("first sync = %+v, want updated success", first)
	}
	if second := syncSkills(context.Background(), client, logger); second.Err != nil || !second.Checked || second.Updated {
		t.Fatalf("second sync = %+v, want unchanged success", second)
	}
}

func TestFingerprintSkillsOrderIndependent(t *testing.T) {
	a := []orchestrator.Skill{
		{Slug: "a", SHA256: "1"},
		{Slug: "b", SHA256: "2"},
	}
	b := []orchestrator.Skill{
		{Slug: "b", SHA256: "2"},
		{Slug: "a", SHA256: "1"},
	}
	if fingerprintSkills(a) != fingerprintSkills(b) {
		t.Fatal("fingerprint must be order-independent")
	}
}

func TestFingerprintSkillsChangesWhenShaChanges(t *testing.T) {
	a := []orchestrator.Skill{{Slug: "a", SHA256: "1"}}
	b := []orchestrator.Skill{{Slug: "a", SHA256: "2"}}
	if fingerprintSkills(a) == fingerprintSkills(b) {
		t.Fatal("sha change must alter fingerprint")
	}
}

// User-authored native skills and prompts must survive every sync and every
// wrapper release. Until 2026-11 a per-version "legacy cleanup" deleted these
// directories on the first sync after each wrapper update.
func TestSyncSkillsKeepsUserSkillAndPromptDirs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	dirs := []string{
		filepath.Join(home, ".agents", "skills", "mine"),
		filepath.Join(home, ".codex", "skills", "mine"),
		filepath.Join(home, ".codex", "prompts"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "SKILL.md"), []byte("user content"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"skills":[{"slug":"git","sha256":"abc"}]}`)
	}))
	defer server.Close()
	cfg := &config.Config{Engine: "codex", Host: config.Host{Secure: true}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}}
	// The communicator "skills" operation is where the old prune ran unconditionally.
	if got := CommunicatorWork(context.Background(), cfg, communicator.SyncRequest{Operation: "skills"}); got.Error != nil {
		t.Fatalf("skills operation = %+v", got.Error)
	}
	for _, d := range dirs {
		if _, err := os.Stat(filepath.Join(d, "SKILL.md")); err != nil {
			t.Fatalf("user content in %s was removed: %v", d, err)
		}
	}
}

func TestSkillsDigestRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := readSkillsDigest(); got != "" {
		t.Fatalf("fresh HOME should yield empty digest, got %q", got)
	}
	writeSkillsDigest("abc123")
	if got := readSkillsDigest(); got != "abc123" {
		t.Fatalf("digest round-trip failed: got %q", got)
	}
}
