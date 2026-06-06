package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestAuthPathDualLocationSelection covers the robust two-path contract:
//
//  1. newest usable credential file wins.
//  2. ~/.claude wins ties because upstream Claude Code writes there.
//  3. missing files fall back to ~/.claude for first write.
func TestAuthPathDualLocationSelection(t *testing.T) {
	cases := []struct {
		name       string
		setupClx   bool
		setupClaud bool
		wantSuffix string
	}{
		{
			name:       "neither_exists_falls_back_to_claude",
			setupClx:   false,
			setupClaud: false,
			wantSuffix: filepath.Join(".claude", ".credentials.json"),
		},
		{
			name:       "only_claude_exists_returns_claude",
			setupClx:   false,
			setupClaud: true,
			wantSuffix: filepath.Join(".claude", ".credentials.json"),
		},
		{
			name:       "only_clx_exists_returns_clx",
			setupClx:   true,
			setupClaud: false,
			wantSuffix: filepath.Join(".clx", "auth", "credentials.json"),
		},
		{
			name:       "both_exist_claude_wins_tie",
			setupClx:   true,
			setupClaud: true,
			wantSuffix: filepath.Join(".claude", ".credentials.json"),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)

			if tc.setupClx {
				dir := filepath.Join(home, ".clx", "auth")
				if err := os.MkdirAll(dir, 0o700); err != nil {
					t.Fatalf("mkdir clx: %v", err)
				}
				if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte(`{"api_key":"clx-key"}`), 0o600); err != nil {
					t.Fatalf("write clx: %v", err)
				}
			}
			if tc.setupClaud {
				dir := filepath.Join(home, ".claude")
				if err := os.MkdirAll(dir, 0o700); err != nil {
					t.Fatalf("mkdir claude: %v", err)
				}
				if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(`{"api_key":"claude-key"}`), 0o600); err != nil {
					t.Fatalf("write claude: %v", err)
				}
			}

			got, err := AuthPath()
			if err != nil {
				t.Fatalf("AuthPath: %v", err)
			}
			want := filepath.Join(home, tc.wantSuffix)
			if got != want {
				t.Errorf("AuthPath() = %q, want %q", got, want)
			}
		})
	}
}

func TestAuthPathChoosesNewestUsableFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	claudeDir := filepath.Join(home, ".claude")
	clxDir := filepath.Join(home, ".clx", "auth")
	if err := os.MkdirAll(claudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(clxDir, 0o700); err != nil {
		t.Fatal(err)
	}
	claudePath := filepath.Join(claudeDir, ".credentials.json")
	clxPath := filepath.Join(clxDir, "credentials.json")
	if err := os.WriteFile(claudePath, []byte(`{"api_key":"claude-key"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(clxPath, []byte(`{"api_key":"clx-key"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	newer := time.Now()
	if err := os.Chtimes(claudePath, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(clxPath, newer, newer); err != nil {
		t.Fatal(err)
	}

	got, err := AuthPath()
	if err != nil {
		t.Fatalf("AuthPath: %v", err)
	}
	if got != clxPath {
		t.Fatalf("AuthPath() = %q, want newest %q", got, clxPath)
	}
}

// TestWriteAuthCreatesParentDir verifies WriteAuth always lands where upstream
// Claude Code reads credentials on first use.
func TestWriteAuthCreatesParentDirForClaudeFallback(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	payload := json.RawMessage(`{"api_key":"abc"}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatalf("WriteAuth: %v", err)
	}
	dst := filepath.Join(home, ".claude", ".credentials.json")
	raw, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(raw) != `{"api_key":"abc"}` {
		t.Errorf("written payload = %q", raw)
	}
}

func TestWriteAuthHonoursClxPathWhenPreStaged(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	dir := filepath.Join(home, ".clx", "auth")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir clx: %v", err)
	}
	// Seed an empty placeholder so AuthPath chooses the clx location.
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	payload := json.RawMessage(`{"api_key":"new"}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatalf("WriteAuth: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "credentials.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(raw) != `{"api_key":"new"}` {
		t.Errorf("clx location not updated: %q", raw)
	}
	claudeRaw, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil {
		t.Fatalf("read claude mirror: %v", err)
	}
	if string(claudeRaw) != `{"api_key":"new"}` {
		t.Errorf("claude location not mirrored: %q", claudeRaw)
	}
}

func TestReadAuthForUploadBackfillsLastRefreshOnlyInMemory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ".credentials.json")
	original := `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc","refreshToken":"r"}}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	raw, gotPath, err := ReadAuthForUpload()
	if err != nil {
		t.Fatalf("ReadAuthForUpload: %v", err)
	}
	if gotPath != path {
		t.Fatalf("path = %q, want %q", gotPath, path)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("upload json: %v", err)
	}
	if out["last_refresh"] == "" {
		t.Fatalf("last_refresh missing in upload payload: %s", raw)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != original {
		t.Fatalf("ReadAuthForUpload mutated disk: %s", onDisk)
	}
}

// TestExtractAnthropicKey covers the four legacy credential shapes the
// wrapper accepts. Preserved from the bash extract_anthropic_key fragment.
func TestExtractAnthropicKey(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"api_key_flat", `{"api_key":"sk-abc"}`, "sk-abc"},
		{"anthropic_api_key", `{"anthropic_api_key":"sk-aap"}`, "sk-aap"},
		{"oauth_access_token", `{"claudeAiOauth":{"accessToken":"oat-1"}}`, "oat-1"},
		{"auths_map", `{"auths":{"api.anthropic.com":{"token":"tok-1"}}}`, "tok-1"},
		{"precedence_api_key_first", `{"api_key":"first","anthropic_api_key":"second"}`, "first"},
		{"empty_object", `{}`, ""},
		{"malformed_json", `{not-json`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractAnthropicKey([]byte(tc.raw)); got != tc.want {
				t.Errorf("extractAnthropicKey(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}
