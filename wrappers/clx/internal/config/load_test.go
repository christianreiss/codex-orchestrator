package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testKeypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

// writeUnsignedConfig writes a valid config payload without the .sig sidecar.
func writeUnsignedConfig(t *testing.T, dir string) string {
	t.Helper()
	raw, err := json.Marshal(validCfg())
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "clx.json")
	if err := os.WriteFile(p, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestVerifyDetachedAcceptsRawAndBase64Signatures(t *testing.T) {
	pub, priv := testKeypair(t)
	payload := []byte(`{"schema_version":1,"engine":"claude"}`)
	sig := ed25519.Sign(priv, payload)

	cases := []struct {
		name   string
		sigRaw []byte
	}{
		{"raw bytes", sig},
		{"base64", []byte(base64.StdEncoding.EncodeToString(sig))},
		{"base64 with trailing newline", []byte(base64.StdEncoding.EncodeToString(sig) + "\n")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := VerifyDetached(payload, tc.sigRaw, pub); err != nil {
				t.Fatalf("expected %s signature to verify: %v", tc.name, err)
			}
		})
	}
}

func TestVerifyDetachedRejectsWrongLengthSignature(t *testing.T) {
	pub, priv := testKeypair(t)
	payload := []byte("host config payload")
	sig := ed25519.Sign(priv, payload)

	cases := []struct {
		name   string
		sigRaw []byte
	}{
		{"empty", nil},
		{"truncated", sig[:ed25519.SignatureSize-1]},
		{"over-long", append(append([]byte{}, sig...), 0x00)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := VerifyDetached(payload, tc.sigRaw, pub)
			if err == nil {
				t.Fatalf("expected %s signature to be rejected", tc.name)
			}
			if !strings.Contains(err.Error(), "wrong length") {
				t.Fatalf("expected length complaint, got %v", err)
			}
		})
	}
}

func TestVerifyDetachedRejectsSignatureOverDifferentBytes(t *testing.T) {
	pub, priv := testKeypair(t)
	sig := ed25519.Sign(priv, []byte("the payload that was signed"))

	err := VerifyDetached([]byte("a different payload"), sig, pub)
	if err == nil {
		t.Fatal("expected verify failure for a signature over other bytes")
	}
	if !strings.Contains(err.Error(), "ed25519 verify failed") {
		t.Fatalf("expected verify failure, got %v", err)
	}
}

func TestLoadRefusesWithoutPublicKey(t *testing.T) {
	p := writeUnsignedConfig(t, t.TempDir())

	_, err := Load(p, nil, false)
	if err == nil {
		t.Fatal("expected refusal to load a config with no public key")
	}
	if !strings.Contains(err.Error(), "refusing to load unsigned config") {
		t.Fatalf("expected unsigned refusal, got %v", err)
	}
}

func TestLoadRefusesWhenSignatureFileMissing(t *testing.T) {
	p := writeUnsignedConfig(t, t.TempDir())
	pub, _ := testKeypair(t)

	_, err := Load(p, pub, false)
	if err == nil {
		t.Fatal("expected refusal when the .sig sidecar is absent")
	}
	if !strings.Contains(err.Error(), "read signature") {
		t.Fatalf("expected signature read failure, got %v", err)
	}
	if _, err := Load(p, nil, true); err != nil {
		t.Fatalf("same payload should load when unsigned loads are allowed: %v", err)
	}
}

func TestLoadReportsMissingConfigFile(t *testing.T) {
	pub, _ := testKeypair(t)

	_, err := Load(filepath.Join(t.TempDir(), "absent.json"), pub, false)
	if err == nil {
		t.Fatal("expected failure for a missing config file")
	}
	if !strings.Contains(err.Error(), "read config") {
		t.Fatalf("expected config read failure, got %v", err)
	}
}

func TestDefaultPathPrefersConfigPathEnv(t *testing.T) {
	t.Setenv("CLX_CONFIG_PATH", "/etc/codex-orchestrator/override.json")
	t.Setenv("XDG_CONFIG_HOME", "/xdg")
	t.Setenv("HOME", "/home/someone")

	got, err := DefaultPath()
	if err != nil {
		t.Fatalf("default path: %v", err)
	}
	if got != "/etc/codex-orchestrator/override.json" {
		t.Fatalf("expected CLX_CONFIG_PATH to win, got %q", got)
	}
}

func TestDefaultPathFallsBackToXDGConfigHome(t *testing.T) {
	t.Setenv("CLX_CONFIG_PATH", "")
	t.Setenv("XDG_CONFIG_HOME", "/xdg")
	t.Setenv("HOME", "/home/someone")

	want := filepath.Join("/xdg", "codex-orchestrator", "clx.json")
	got, err := DefaultPath()
	if err != nil {
		t.Fatalf("default path: %v", err)
	}
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestDefaultPathFallsBackToHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CLX_CONFIG_PATH", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", home)

	want := filepath.Join(home, ".config", "codex-orchestrator", "clx.json")
	got, err := DefaultPath()
	if err != nil {
		t.Fatalf("default path: %v", err)
	}
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestValidateRejectsUnsupportedSchemaVersion(t *testing.T) {
	c := validCfg()
	c.SchemaVersion = SchemaVersion + 1

	err := c.Validate()
	if err == nil {
		t.Fatal("expected unsupported schema_version to be rejected")
	}
	if !strings.Contains(err.Error(), "unsupported schema_version") {
		t.Fatalf("expected schema version complaint, got %v", err)
	}
}

func TestValidateRejectsMissingOrInvalidBaseURL(t *testing.T) {
	cases := []struct {
		name    string
		baseURL string
	}{
		{"missing", ""},
		{"no scheme", "orch.example.com"},
		{"wrong scheme", "ftp://orch.example.com"},
		{"no host", "https://"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := validCfg()
			c.Orchestrator.BaseURL = tc.baseURL
			if err := c.Validate(); err == nil {
				t.Fatalf("expected %s base_url to be rejected", tc.name)
			}
		})
	}
}
