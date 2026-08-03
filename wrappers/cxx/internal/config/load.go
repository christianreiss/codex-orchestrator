package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrExpired marks an on-disk config whose expires_at has passed. Recovery code
// matches it with errors.Is/errors.As so it never depends on message wording.
var ErrExpired = errors.New("config expired")

// ExpiredError reports an expired config found on disk.
//
// Config carries the parsed document so a caller can refetch a replacement
// using credentials that are still authentic — an expiry is a property of the
// reading host's clock, not evidence of tampering. It is populated ONLY when
// the detached signature was verified, so a caller that seeds from it can
// never be seeded from unverified bytes.
type ExpiredError struct {
	ExpiresAt time.Time
	Path      string
	Config    *Config
}

func (e *ExpiredError) Error() string {
	return fmt.Sprintf("config expired at %s", e.ExpiresAt.UTC().Format(time.RFC3339))
}

func (e *ExpiredError) Unwrap() error { return ErrExpired }

// Load reads a config from configPath, verifies the detached Ed25519 signature
// in configPath+".sig" against pubkey, then validates schema invariants.
// Set allowUnsignedForTests=true ONLY in unit tests with a nil pubkey.
func Load(configPath string, pubkey ed25519.PublicKey, allowUnsignedForTests bool) (*Config, error) {
	return LoadForEngine(configPath, pubkey, allowUnsignedForTests, EngineCodex)
}

// LoadForEngine reads and verifies one engine's signed configuration. Keeping
// the expected engine explicit prevents a cdx alias from accidentally consuming
// clx credentials (and vice versa) now that both personas share one binary.
func LoadForEngine(configPath string, pubkey ed25519.PublicKey, allowUnsignedForTests bool, expectedEngine string) (*Config, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	signatureVerified := false
	if !allowUnsignedForTests {
		if pubkey == nil {
			return nil, errors.New("no signing public key available; refusing to load unsigned config")
		}
		sigPath := configPath + ".sig"
		sigRaw, err := os.ReadFile(sigPath)
		if err != nil {
			return nil, fmt.Errorf("read signature: %w", err)
		}
		if err := VerifyDetached(raw, sigRaw, pubkey); err != nil {
			return nil, fmt.Errorf("config signature invalid: %w", err)
		}
		signatureVerified = true
	}

	cfg := &Config{}
	if err := json.Unmarshal(raw, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if err := cfg.ValidateForEngine(expectedEngine); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}
	cfg.sourcePath = configPath
	if absolute, absErr := filepath.Abs(configPath); absErr == nil {
		cfg.sourcePath = absolute
	}
	// Expiry is enforced here and deliberately NOT in ValidateForEngine: the
	// same validator runs on bytes just downloaded from the orchestrator, and a
	// freshly signed config must never be rejected because this host's clock
	// runs ahead. Only a config sitting on disk can have genuinely aged out.
	expiresAt, hasExpiry, expiryErr := cfg.expiresAtTime()
	if expiryErr != nil {
		return nil, fmt.Errorf("validate config: %w", expiryErr)
	}
	if hasExpiry && time.Now().After(expiresAt) {
		expired := &ExpiredError{ExpiresAt: expiresAt, Path: cfg.sourcePath}
		if signatureVerified {
			expired.Config = cfg
		}
		return nil, expired
	}
	return cfg, nil
}

// DefaultPath returns the conventional location for the host config.
func DefaultPath() string {
	path, _ := DefaultPathForEngine(EngineCodex)
	return path
}

// DefaultPathForEngine resolves the engine-specific override and filename.
// The two signed configs remain separate even though their loader is shared.
func DefaultPathForEngine(engine string) (string, error) {
	var envName, filename string
	switch engine {
	case EngineCodex:
		envName, filename = "CDX_CONFIG_PATH", "cdx.json"
	case EngineClaude:
		envName, filename = "CLX_CONFIG_PATH", "clx.json"
	default:
		return "", fmt.Errorf("unsupported engine %q", engine)
	}
	if env := strings.TrimSpace(os.Getenv(envName)); env != "" {
		return env, nil
	}
	if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
		return filepath.Join(xdg, "codex-orchestrator", filename), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home directory: %w", err)
	}
	return filepath.Join(home, ".config", "codex-orchestrator", filename), nil
}

// VerifyDetached checks an Ed25519 signature. The signature file may contain
// raw bytes or a base64-encoded string (one line) — we accept either.
func VerifyDetached(payload, sigRaw []byte, pubkey ed25519.PublicKey) error {
	sig := sigRaw
	// Try base64 decode if the file is short enough to plausibly be encoded.
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

// Validate enforces the invariants that are easy to check without a JSON Schema
// validator. Anything more elaborate stays on the server side in PHP.
func (c *Config) Validate() error {
	return c.ValidateForEngine(EngineCodex)
}

// ValidateForEngine validates shared schema invariants and pins the config to
// the persona selected by the multicall dispatcher.
func (c *Config) ValidateForEngine(expectedEngine string) error {
	if c.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported schema_version %d (want %d)", c.SchemaVersion, SchemaVersion)
	}
	if expectedEngine != EngineCodex && expectedEngine != EngineClaude {
		return fmt.Errorf("unsupported expected engine %q", expectedEngine)
	}
	if c.Engine != expectedEngine {
		return fmt.Errorf("engine %q does not match selected engine %q", c.Engine, expectedEngine)
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
	if c.AgentMessaging.Enabled {
		if !c.Host.Secure || !c.Host.AgentMessagingEnabled {
			return errors.New("agent_messaging requires an enabled secure host")
		}
		if c.AgentMessaging.RelayPollSeconds < 1 || c.AgentMessaging.RelayPollSeconds > 25 {
			return errors.New("agent_messaging.relay_poll_seconds must be between 1 and 25")
		}
		if c.AgentMessaging.QueuedTTLSeconds < 60 || c.AgentMessaging.QueuedTTLSeconds > 604800 {
			return errors.New("agent_messaging.queued_ttl_seconds must be between 60 and 604800")
		}
	}
	if c.Wrapper.Version == "" {
		return errors.New("wrapper.version required")
	}
	if len(c.Wrapper.BinarySHA256) != 64 {
		return errors.New("wrapper.binary_sha256 must be 64 hex chars")
	}
	if _, err := hex.DecodeString(c.Wrapper.BinarySHA256); err != nil {
		return errors.New("wrapper.binary_sha256 must be 64 hex chars")
	}
	if c.Wrapper.BinaryURL == "" {
		return errors.New("wrapper.binary_url required")
	}
	// Only the shape of expires_at is a property of the signed document. Whether
	// it has already passed depends on the reading host's clock, so that check
	// lives in LoadForEngine — see the comment there.
	if _, _, err := c.expiresAtTime(); err != nil {
		return err
	}
	return nil
}

// expiresAtTime parses expires_at. ok is false when the field is absent or
// blank, which means the config never expires.
func (c *Config) expiresAtTime() (time.Time, bool, error) {
	if c.ExpiresAt == nil {
		return time.Time{}, false, nil
	}
	raw := strings.TrimSpace(*c.ExpiresAt)
	if raw == "" {
		return time.Time{}, false, nil
	}
	expiresAt, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("expires_at invalid: %w", err)
	}
	return expiresAt, true, nil
}
