package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func Load(configPath string, pubkey ed25519.PublicKey, allowUnsignedForTests bool) (*Config, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	if !allowUnsignedForTests {
		if pubkey == nil {
			return nil, errors.New("no signing public key available; refusing to load unsigned config")
		}
		sigRaw, err := os.ReadFile(configPath + ".sig")
		if err != nil {
			return nil, fmt.Errorf("read signature: %w", err)
		}
		if err := VerifyDetached(raw, sigRaw, pubkey); err != nil {
			return nil, fmt.Errorf("config signature invalid: %w", err)
		}
	}

	cfg := &Config{}
	if err := json.Unmarshal(raw, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}
	return cfg, nil
}

func DefaultPath() string {
	if env := strings.TrimSpace(os.Getenv("CLX_CONFIG_PATH")); env != "" {
		return env
	}
	if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
		return filepath.Join(xdg, "codex-orchestrator", "clx.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "codex-orchestrator", "clx.json")
}

func VerifyDetached(payload, sigRaw []byte, pubkey ed25519.PublicKey) error {
	sig := sigRaw
	if decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigRaw))); err == nil && len(decoded) == ed25519.SignatureSize {
		sig = decoded
	}
	if len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("signature has wrong length %d", len(sig))
	}
	if !ed25519.Verify(pubkey, payload, sig) {
		return errors.New("ed25519 verify failed")
	}
	return nil
}

func (c *Config) Validate() error {
	if c.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported schema_version %d (want %d)", c.SchemaVersion, SchemaVersion)
	}
	if c.Engine != EngineClaude {
		return fmt.Errorf("engine %q not supported by this binary", c.Engine)
	}
	if c.Orchestrator.BaseURL == "" {
		return errors.New("orchestrator.base_url is required")
	}
	if u, err := url.Parse(c.Orchestrator.BaseURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("orchestrator.base_url invalid: %q", c.Orchestrator.BaseURL)
	}
	if len(c.Orchestrator.APIKey) < 8 {
		return errors.New("orchestrator.api_key too short")
	}
	if c.Host.ID <= 0 {
		return errors.New("host.id must be positive")
	}
	if c.Host.FQDN == "" {
		return errors.New("host.fqdn required")
	}
	if c.Wrapper.Version == "" {
		return errors.New("wrapper.version required")
	}
	if len(c.Wrapper.BinarySHA256) != 64 {
		return errors.New("wrapper.binary_sha256 must be 64 hex chars")
	}
	if c.Wrapper.BinaryURL == "" {
		return errors.New("wrapper.binary_url required")
	}
	return nil
}
