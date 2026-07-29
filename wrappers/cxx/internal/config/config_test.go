package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeSignedFixture(t *testing.T, dir string, cfg *Config) (string, ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	cfgPath := filepath.Join(dir, "cdx.json")
	if err := os.WriteFile(cfgPath, raw, 0o600); err != nil {
		t.Fatalf("write cfg: %v", err)
	}
	sig := ed25519.Sign(priv, raw)
	if err := os.WriteFile(cfgPath+".sig", []byte(base64.StdEncoding.EncodeToString(sig)), 0o600); err != nil {
		t.Fatalf("write sig: %v", err)
	}
	return cfgPath, pub
}

func validCfg() *Config {
	return &Config{
		SchemaVersion: 1,
		Engine:        EngineCodex,
		IssuedAt:      "2026-05-16T10:00:00Z",
		Orchestrator: Orchestrator{
			BaseURL:        "https://orch.example.com",
			APIKey:         "sk-codex-abcdef1234",
			InstallationID: "install-1",
		},
		Host: Host{ID: 42, FQDN: "host01.example.com", Secure: true},
		Wrapper: Wrapper{
			Version:      "0.6.0",
			Track:        "stable",
			AutoUpdate:   true,
			BinaryURL:    "https://orch.example.com/wrapper/v2/bin/cdx/linux-amd64/v0.6.0/cdx",
			BinarySHA256: "0000000000000000000000000000000000000000000000000000000000000000",
		},
	}
}

func TestLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	fixture := validCfg()
	fixture.Host.BrowserOSMCPEnabled = true
	cfgPath, pub := writeSignedFixture(t, dir, fixture)
	cfg, err := Load(cfgPath, pub, false)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Host.ID != 42 {
		t.Fatalf("host id mismatch: %d", cfg.Host.ID)
	}
	if !cfg.Host.BrowserOSMCPEnabled {
		t.Fatal("expected browseros_mcp_enabled to round-trip")
	}
}

func TestLoadRejectsTamperedConfig(t *testing.T) {
	dir := t.TempDir()
	cfgPath, pub := writeSignedFixture(t, dir, validCfg())
	raw, _ := os.ReadFile(cfgPath)
	raw[len(raw)-2] ^= 0x01
	_ = os.WriteFile(cfgPath, raw, 0o600)
	if _, err := Load(cfgPath, pub, false); err == nil {
		t.Fatal("expected signature failure on tampered config")
	}
}

func TestLoadRejectsWrongEngine(t *testing.T) {
	dir := t.TempDir()
	c := validCfg()
	c.Engine = "claude"
	cfgPath, pub := writeSignedFixture(t, dir, c)
	if _, err := Load(cfgPath, pub, false); err == nil {
		t.Fatal("expected engine mismatch")
	}
}

func TestLoadRejectsBadSchemaVersion(t *testing.T) {
	dir := t.TempDir()
	c := validCfg()
	c.SchemaVersion = 99
	cfgPath, pub := writeSignedFixture(t, dir, c)
	if _, err := Load(cfgPath, pub, false); err == nil {
		t.Fatal("expected schema version mismatch")
	}
}

func TestValidateRequiresBaseURL(t *testing.T) {
	c := validCfg()
	c.Orchestrator.BaseURL = ""
	if err := c.Validate(); err == nil {
		t.Fatal("expected base_url required")
	}
}
