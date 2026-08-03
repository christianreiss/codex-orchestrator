package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testKeypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	return pub, priv
}

// writeUnsignedConfig writes a valid config payload without the .sig sidecar.
func writeUnsignedConfig(t *testing.T, dir string) string {
	t.Helper()
	raw, err := json.Marshal(validCfg())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	cfgPath := filepath.Join(dir, "cdx.json")
	if err := os.WriteFile(cfgPath, raw, 0o600); err != nil {
		t.Fatalf("write cfg: %v", err)
	}
	return cfgPath
}

func TestVerifyDetachedAcceptsRawAndBase64Signatures(t *testing.T) {
	pub, priv := testKeypair(t)
	payload := []byte(`{"schema_version":1,"engine":"codex"}`)
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
	cfgPath := writeUnsignedConfig(t, t.TempDir())

	_, err := Load(cfgPath, nil, false)
	if err == nil {
		t.Fatal("expected refusal to load a config with no public key")
	}
	if !strings.Contains(err.Error(), "refusing to load unsigned config") {
		t.Fatalf("expected unsigned refusal, got %v", err)
	}
}

func TestLoadRefusesWhenSignatureFileMissing(t *testing.T) {
	cfgPath := writeUnsignedConfig(t, t.TempDir())
	pub, _ := testKeypair(t)

	_, err := Load(cfgPath, pub, false)
	if err == nil {
		t.Fatal("expected refusal when the .sig sidecar is absent")
	}
	if !strings.Contains(err.Error(), "read signature") {
		t.Fatalf("expected signature read failure, got %v", err)
	}
	cfg, err := Load(cfgPath, nil, true)
	if err != nil {
		t.Fatalf("same payload should load when unsigned loads are allowed: %v", err)
	}
	if cfg.SourcePath() != cfgPath {
		t.Fatalf("loaded config source path = %q, want %q", cfg.SourcePath(), cfgPath)
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
	t.Setenv("CDX_CONFIG_PATH", "/etc/codex-orchestrator/override.json")
	t.Setenv("XDG_CONFIG_HOME", "/xdg")
	t.Setenv("HOME", "/home/someone")

	if got := DefaultPath(); got != "/etc/codex-orchestrator/override.json" {
		t.Fatalf("expected CDX_CONFIG_PATH to win, got %q", got)
	}
}

func TestDefaultPathFallsBackToXDGConfigHome(t *testing.T) {
	t.Setenv("CDX_CONFIG_PATH", "")
	t.Setenv("XDG_CONFIG_HOME", "/xdg")
	t.Setenv("HOME", "/home/someone")

	want := filepath.Join("/xdg", "codex-orchestrator", "cdx.json")
	if got := DefaultPath(); got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestDefaultPathFallsBackToHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CDX_CONFIG_PATH", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", home)

	want := filepath.Join(home, ".config", "codex-orchestrator", "cdx.json")
	if got := DefaultPath(); got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

// Validate runs on freshly downloaded bytes too, where a past expires_at can
// only mean the reading host's clock is ahead. Rejecting there would make a
// skewed clock refuse every replacement config it fetches.
func TestValidateAcceptsAlreadyExpiredConfig(t *testing.T) {
	c := validCfg()
	past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	c.ExpiresAt = &past

	if err := c.Validate(); err != nil {
		t.Fatalf("expected a freshly signed but expired-looking config to validate: %v", err)
	}
}

func TestValidateRejectsUnparseableExpiresAt(t *testing.T) {
	c := validCfg()
	broken := "not-a-timestamp"
	c.ExpiresAt = &broken

	err := c.Validate()
	if err == nil || !strings.Contains(err.Error(), "expires_at invalid") {
		t.Fatalf("expected expires_at shape complaint, got %v", err)
	}
}

func TestValidateAcceptsUnexpiredConfig(t *testing.T) {
	c := validCfg()
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	c.ExpiresAt = &future

	if err := c.Validate(); err != nil {
		t.Fatalf("expected unexpired config to validate: %v", err)
	}
}

func TestLoadForEngineRejectsExpiredConfigOnDisk(t *testing.T) {
	fixture := validCfg()
	expiry := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	past := expiry.Format(time.RFC3339)
	fixture.ExpiresAt = &past
	cfgPath, pub := writeSignedFixture(t, t.TempDir(), fixture)

	cfg, err := LoadForEngine(cfgPath, pub, false, EngineCodex)
	if cfg != nil {
		t.Fatal("expired config must not be returned as usable")
	}
	if !errors.Is(err, ErrExpired) {
		t.Fatalf("expected ErrExpired, got %v", err)
	}
	var expired *ExpiredError
	if !errors.As(err, &expired) {
		t.Fatalf("expected *ExpiredError, got %T", err)
	}
	if !expired.ExpiresAt.Equal(expiry) {
		t.Fatalf("ExpiresAt=%s, want %s", expired.ExpiresAt, expiry)
	}
	// The signature verified, so the recovery path may reuse these credentials.
	if expired.Config == nil || expired.Config.Orchestrator.APIKey != fixture.Orchestrator.APIKey {
		t.Fatalf("expected the verified config to be offered as a refetch seed, got %+v", expired.Config)
	}
	if expired.Path != cfgPath {
		t.Fatalf("Path=%q, want %q", expired.Path, cfgPath)
	}
}

// A config nobody verified must never become a refetch seed: its base_url and
// api_key would be attacker-chosen.
func TestLoadForEngineWithheldSeedForUnverifiedExpiredConfig(t *testing.T) {
	fixture := validCfg()
	past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	fixture.ExpiresAt = &past
	cfgPath := filepath.Join(t.TempDir(), "cdx.json")
	raw, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	_, err = LoadForEngine(cfgPath, nil, true, EngineCodex)
	var expired *ExpiredError
	if !errors.As(err, &expired) {
		t.Fatalf("expected *ExpiredError, got %v", err)
	}
	if expired.Config != nil {
		t.Fatal("an unverified expired config must not be offered as a refetch seed")
	}
}

func TestLoadForEngineAcceptsUnexpiredConfigOnDisk(t *testing.T) {
	fixture := validCfg()
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	fixture.ExpiresAt = &future
	cfgPath, pub := writeSignedFixture(t, t.TempDir(), fixture)

	if _, err := LoadForEngine(cfgPath, pub, false, EngineCodex); err != nil {
		t.Fatalf("unexpired config rejected: %v", err)
	}
}

func TestValidateRejectsNonHexWrapperDigest(t *testing.T) {
	c := validCfg()
	c.Wrapper.BinarySHA256 = "z" + strings.Repeat("0", 63)
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "64 hex chars") {
		t.Fatalf("non-hex wrapper digest accepted: %v", err)
	}
}
