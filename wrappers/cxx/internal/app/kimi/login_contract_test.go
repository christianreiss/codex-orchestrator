package kimi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/kimi"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestDeviceLoginUploadsCanonicalPayloadAndDeletesSeedHome(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KIMI_CODE_HOME", t.TempDir())
	marker := filepath.Join(t.TempDir(), "seed-home")
	t.Setenv("CKX_TEST_SEED_MARKER", marker)
	bin := filepath.Join(t.TempDir(), "kimi")
	script := `#!/bin/sh
[ "$1" = login ] || exit 9
[ "$KIMI_CODE_NO_AUTO_UPDATE" = 1 ] || exit 8
[ "$KIMI_DISABLE_TELEMETRY" = 1 ] || exit 7
printf '%s' "$KIMI_CODE_HOME" > "$CKX_TEST_SEED_MARKER"
mkdir -p "$KIMI_CODE_HOME/credentials"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' > "$KIMI_CODE_HOME/device_id"
printf '%s' '{"access_token":"seed-access","refresh_token":"seed-refresh","expires_at":` + strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10) + `,"expires_in":900,"scope":"kimi-code","token_type":"Bearer"}' > "$KIMI_CODE_HOME/credentials/kimi-code.json"
`
	if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CKX_KIMI_BIN", bin)
	uploads := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth" {
			t.Errorf("unexpected %s", r.URL)
			w.WriteHeader(500)
			return
		}
		var body struct {
			Engine, Command string
			Auth            native.AuthEnvelope `json:"auth"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Engine != "kimi" || body.Command != "store" || body.Auth.KimiCode.RefreshToken != "seed-refresh" || body.Auth.DeviceID != strings.Repeat("a", 32) || body.Auth.LastRefresh == "" {
			t.Error("bad canonical login shape")
			w.WriteHeader(500)
			return
		}
		uploads++
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"status":"valid","verification_state":"verified"}`)
	}))
	defer server.Close()
	cfg := &config.Config{Engine: config.EngineKimi, Host: config.Host{Secure: true}}
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	if err := login(context.Background(), cfg, client, nil, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if uploads != 1 {
		t.Fatal(uploads)
	}
	raw, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(string(raw)); !os.IsNotExist(err) {
		t.Fatal("seed home retained")
	}
}

// kimi-code mints a dashed UUID when the fresh login home has no device_id
// file; the login must accept the same forms as the runtime and the server.
func TestValidDeviceIDAcceptsHexAndDashedUUID(t *testing.T) {
	for value, want := range map[string]bool{
		strings.Repeat("a", 32):                  true,
		"0F1E2D3C4B5A69788796A5B4C3D2E1F0":       true,
		"3f9c5d7e-2a4b-4c6d-8e0f-1a2b3c4d5e6f":   true,
		"3F9C5D7E-2A4B-4C6D-8E0F-1A2B3C4D5E6F":   true,
		"":                                       false,
		strings.Repeat("a", 31):                  false,
		strings.Repeat("g", 32):                  false,
		"3f9c5d7e2a4b-4c6d-8e0f-1a2b3c4d5e6f":    false,
		"3f9c5d7e-2a4b-4c6d-8e0f-1a2b3c4d5e6f\n": false,
	} {
		if got := validDeviceID(value); got != want {
			t.Errorf("validDeviceID(%q) = %v, want %v", value, got, want)
		}
	}
}
