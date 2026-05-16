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
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "clx.json")
	if err := os.WriteFile(p, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, raw)
	if err := os.WriteFile(p+".sig", []byte(base64.StdEncoding.EncodeToString(sig)), 0o600); err != nil {
		t.Fatal(err)
	}
	return p, pub
}

func validCfg() *Config {
	return &Config{
		SchemaVersion: 1,
		Engine:        EngineClaude,
		IssuedAt:      "2026-05-16T10:00:00Z",
		Orchestrator: Orchestrator{
			BaseURL:        "https://orch.example.com",
			APIKey:         "sk-claude-abcdef1234",
			InstallationID: "install-1",
		},
		Host: Host{ID: 7, FQDN: "host02.example.com", Secure: true},
		Wrapper: Wrapper{
			Version:      "0.6.0",
			Track:        "stable",
			AutoUpdate:   true,
			BinaryURL:    "https://orch.example.com/wrapper/v2/bin/clx/linux-amd64/v0.6.0/clx",
			BinarySHA256: "1111111111111111111111111111111111111111111111111111111111111111",
		},
	}
}

func TestLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	p, pub := writeSignedFixture(t, dir, validCfg())
	cfg, err := Load(p, pub, false)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Host.ID != 7 {
		t.Fatalf("host id: %d", cfg.Host.ID)
	}
}

func TestRejectsCodexEngine(t *testing.T) {
	dir := t.TempDir()
	c := validCfg()
	c.Engine = "codex"
	p, pub := writeSignedFixture(t, dir, c)
	if _, err := Load(p, pub, false); err == nil {
		t.Fatal("expected engine mismatch")
	}
}

func TestRejectsTampered(t *testing.T) {
	dir := t.TempDir()
	p, pub := writeSignedFixture(t, dir, validCfg())
	raw, _ := os.ReadFile(p)
	raw[len(raw)-2] ^= 0x01
	_ = os.WriteFile(p, raw, 0o600)
	if _, err := Load(p, pub, false); err == nil {
		t.Fatal("expected signature failure")
	}
}
