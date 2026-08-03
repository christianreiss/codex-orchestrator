package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// Consumer half of the round-trip golden fixtures in wrappers/testdata.
//
// api/test/unit/contract/wrapper-config-golden.test.ts owns the bytes: it bakes
// each fixture with the clock, the DB, the binary registry, the installation id
// and the signing seed frozen, and asserts the canonical JSON is byte-identical
// to the file. This side proves the same bytes are a config the wrapper really
// accepts: the detached Ed25519 signature verifies against the checked-in
// TEST-ONLY seed, the loader and ValidateForEngine accept the document, and
// every decoded field matches a literal written out here.
//
// The expectations below are literals ON PURPOSE. Deriving them from the file
// would compare the fixture to itself and pass forever; as written, a baker
// change that someone regenerates with UPDATE_GOLDEN=1 fails here until the Go
// side is taught about it.
//
// See wrappers/testdata/README.md for the determinism contract.

const goldenDir = "../../../testdata"

// goldenUndecodedKeys names the payload keys Config deliberately does not
// decode. `documents` and `skills` are orchestrator-side provenance the wrapper
// never reads, and `etag` is a server-side cache token. Naming them turns "Go
// silently ignores three keys" into a stated contract: TestGoldenTopLevelKeySet
// fails on any NEW key on either side.
var goldenUndecodedKeys = []string{"documents", "etag", "skills"}

// goldenPublicKey derives the fixture verification key from the checked-in
// TEST-ONLY seed. Ed25519 is deterministic (RFC 8032), so seed -> key -> the
// exact signature bytes in the .sig sidecars.
func goldenPublicKey(t *testing.T) ed25519.PublicKey {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(goldenDir, "signing-seed.TEST-ONLY.txt"))
	if err != nil {
		t.Fatalf("read test seed: %v", err)
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("decode test seed: %v", err)
	}
	if len(seed) != ed25519.SeedSize {
		t.Fatalf("test seed is %d bytes, want %d", len(seed), ed25519.SeedSize)
	}
	return ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
}

func goldenString(v string) *string { return &v }

type goldenFixture struct {
	name   string
	engine string
	want   Config
}

// Every fixture is stamped issued_at 2026-01-15T00:00:00Z with the 30-day
// WRAPPER_CONFIG_TTL_SECONDS, so expires_at is a fixed literal in the past and
// LoadForEngine ALWAYS returns *ExpiredError. That is deterministic by
// construction rather than a date-dependent coin flip — and it means a baker
// that stopped emitting expires_at fails here.
const (
	goldenIssuedAt  = "2026-01-15T00:00:00Z"
	goldenExpiresAt = "2026-02-14T00:00:00Z"
)

func goldenFixtures() []goldenFixture {
	return []goldenFixture{
		{
			name:   "host-codex.json",
			engine: EngineCodex,
			want: Config{
				SchemaVersion: SchemaVersion,
				Engine:        EngineCodex,
				IssuedAt:      goldenIssuedAt,
				ExpiresAt:     goldenString(goldenExpiresAt),
				Orchestrator: Orchestrator{
					BaseURL:        "https://orchestrator.example.com",
					APIKey:         "sk-golden-codex-not-a-real-key",
					CABundlePath:   nil,
					AllowInsecure:  false,
					InstallationID: "golden-installation-0001",
				},
				Host: Host{
					ID:                    42,
					FQDN:                  "host-a.fleet.example.com",
					Secure:                true,
					BrowserOSMCPEnabled:   true,
					AgentMessagingEnabled: true,
					Engines:               "codex,claude",
					EnginesList:           []string{"codex", "claude"},
				},
				EngineOptions: EngineOptions{
					Silent:                  false,
					ModelOverride:           goldenString("gpt-5.4-codex"),
					ReasoningEffortOverride: goldenString("high"),
					AdminThemeHint:          goldenString("dark"),
				},
				AgentMessaging: AgentMessaging{
					Enabled:               true,
					RelayPollSeconds:      25,
					QueuedTTLSeconds:      86400,
					ChannelPreviewEnabled: false,
				},
				Wrapper: Wrapper{
					Version:      "2.4.0",
					Track:        "stable",
					AutoUpdate:   true,
					BinaryURL:    "https://orchestrator.example.com/wrapper/v2/bin/cxx/linux-amd64/v2.4.0/cxx",
					BinarySHA256: strings.Repeat("b1", 32),
				},
				ConfigVersion: 12,
			},
		},
		{
			// secure=0 AND curl_insecure=1. The interlock the wrapper enforces
			// is that agent messaging never runs on an insecure host; what this
			// fixture pins is the producer half — the baker cannot emit the
			// combination ValidateForEngine rejects, so the document loads.
			name:   "host-codex-insecure.json",
			engine: EngineCodex,
			want: Config{
				SchemaVersion: SchemaVersion,
				Engine:        EngineCodex,
				IssuedAt:      goldenIssuedAt,
				ExpiresAt:     goldenString(goldenExpiresAt),
				Orchestrator: Orchestrator{
					BaseURL:        "https://orchestrator.example.com",
					APIKey:         "sk-golden-insecure-not-a-real-key",
					CABundlePath:   nil,
					AllowInsecure:  true,
					InstallationID: "golden-installation-0001",
				},
				Host: Host{
					ID:                    43,
					FQDN:                  "host-b.fleet.example.com",
					Secure:                false,
					BrowserOSMCPEnabled:   false,
					AgentMessagingEnabled: true,
					Engines:               "codex",
					EnginesList:           []string{"codex"},
				},
				EngineOptions: EngineOptions{
					Silent:                  true,
					ModelOverride:           nil,
					ReasoningEffortOverride: nil,
					AdminThemeHint:          nil,
				},
				AgentMessaging: AgentMessaging{
					Enabled:               false,
					RelayPollSeconds:      25,
					QueuedTTLSeconds:      86400,
					ChannelPreviewEnabled: false,
				},
				Wrapper: Wrapper{
					Version:      "2.4.0",
					Track:        "beta",
					AutoUpdate:   false,
					BinaryURL:    "https://orchestrator.example.com/wrapper/v2/bin/cxx/linux-amd64/v2.4.0/cxx",
					BinarySHA256: strings.Repeat("b1", 32),
				},
				ConfigVersion: 5,
			},
		},
		{
			name:   "host-claude.json",
			engine: EngineClaude,
			want: Config{
				SchemaVersion: SchemaVersion,
				Engine:        EngineClaude,
				IssuedAt:      goldenIssuedAt,
				ExpiresAt:     goldenString(goldenExpiresAt),
				Orchestrator: Orchestrator{
					BaseURL:        "https://orchestrator.example.com",
					APIKey:         "sk-golden-claude-not-a-real-key",
					CABundlePath:   nil,
					AllowInsecure:  false,
					InstallationID: "golden-installation-0001",
				},
				Host: Host{
					ID:                    44,
					FQDN:                  "host-c.fleet.example.com",
					Secure:                true,
					BrowserOSMCPEnabled:   false,
					AgentMessagingEnabled: false,
					Engines:               "claude",
					EnginesList:           []string{"claude"},
				},
				EngineOptions: EngineOptions{
					Silent: false,
					// The claude bake emits claude_model_override in place of
					// model_override/reasoning_effort_override.
					ClaudeModelOverride: goldenString("claude-opus-4.7"),
					AdminThemeHint:      goldenString("auto"),
				},
				AgentMessaging: AgentMessaging{
					Enabled:               false,
					RelayPollSeconds:      25,
					QueuedTTLSeconds:      86400,
					ChannelPreviewEnabled: false,
				},
				Wrapper: Wrapper{
					Version:      "2.4.0",
					Track:        "stable",
					AutoUpdate:   true,
					BinaryURL:    "https://orchestrator.example.com/wrapper/v2/bin/cxx/linux-amd64/v2.4.0/cxx",
					BinarySHA256: strings.Repeat("b1", 32),
				},
				ConfigVersion: 8,
			},
		},
	}
}

// TestGoldenSignatureVerifies checks the detached signature on its own, so a
// signature failure is never confused with an expiry or a validation failure.
func TestGoldenSignatureVerifies(t *testing.T) {
	pub := goldenPublicKey(t)
	for _, fixture := range goldenFixtures() {
		t.Run(fixture.name, func(t *testing.T) {
			path := filepath.Join(goldenDir, fixture.name)
			payload, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			sig, err := os.ReadFile(path + ".sig")
			if err != nil {
				t.Fatalf("read signature: %v", err)
			}
			if err := VerifyDetached(payload, sig, pub); err != nil {
				t.Fatalf("golden signature must verify: %v", err)
			}
		})
	}
}

// TestGoldenDecodesToExpectedFields runs the real signed-load path — no
// allowUnsignedForTests — and compares every decoded field to a literal.
func TestGoldenDecodesToExpectedFields(t *testing.T) {
	pub := goldenPublicKey(t)
	for _, fixture := range goldenFixtures() {
		t.Run(fixture.name, func(t *testing.T) {
			path := filepath.Join(goldenDir, fixture.name)
			got := loadGolden(t, path, pub, fixture.engine)

			abs, err := filepath.Abs(path)
			if err != nil {
				t.Fatalf("abs: %v", err)
			}
			if got.SourcePath() != abs {
				t.Fatalf("sourcePath = %q, want %q", got.SourcePath(), abs)
			}
			// sourcePath is loader metadata, never part of the signed document.
			got.sourcePath = ""

			if !reflect.DeepEqual(*got, fixture.want) {
				t.Fatalf("decoded config mismatch\n got: %+v\nwant: %+v", *got, fixture.want)
			}
		})
	}
}

// TestGoldenRejectsTamperedFixture proves the load above is a real signature
// check: one flipped byte in the payload must not survive it.
func TestGoldenRejectsTamperedFixture(t *testing.T) {
	pub := goldenPublicKey(t)
	fixture := goldenFixtures()[0]
	payload, err := os.ReadFile(filepath.Join(goldenDir, fixture.name))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	sig, err := os.ReadFile(filepath.Join(goldenDir, fixture.name+".sig"))
	if err != nil {
		t.Fatalf("read signature: %v", err)
	}

	dir := t.TempDir()
	tampered := filepath.Join(dir, fixture.name)
	if err := os.WriteFile(tampered, []byte(strings.Replace(string(payload), `"secure":true`, `"secure":false`, 1)), 0o600); err != nil {
		t.Fatalf("write tampered: %v", err)
	}
	if err := os.WriteFile(tampered+".sig", sig, 0o600); err != nil {
		t.Fatalf("write signature: %v", err)
	}
	_, err = LoadForEngine(tampered, pub, false, fixture.engine)
	if err == nil {
		t.Fatal("tampered golden fixture must not load")
	}
	// The signature is checked before the document is even parsed, so the
	// rejection must be the signature — not the schema invariant the flipped
	// byte happens to break as well.
	if !strings.Contains(err.Error(), "config signature invalid") {
		t.Fatalf("want a signature rejection, got: %v", err)
	}
}

// TestGoldenTopLevelKeySet closes the Go/TS asymmetry explicitly. The fixture's
// top-level key set must be exactly the keys Config declares plus the named
// undecoded allowlist, so a NEW baked key nobody taught Go about fails here —
// and so does a NEW Config field the fixtures do not carry.
func TestGoldenTopLevelKeySet(t *testing.T) {
	declared := declaredConfigJSONKeys()
	want := append(append([]string{}, declared...), goldenUndecodedKeys...)
	sort.Strings(want)

	for _, fixture := range goldenFixtures() {
		t.Run(fixture.name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(goldenDir, fixture.name))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			var generic map[string]any
			if err := json.Unmarshal(raw, &generic); err != nil {
				t.Fatalf("unmarshal fixture: %v", err)
			}
			got := make([]string, 0, len(generic))
			for key := range generic {
				got = append(got, key)
			}
			sort.Strings(got)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("top-level keys = %v, want %v (decoded by Config: %v; intentionally undecoded: %v)",
					got, want, declared, goldenUndecodedKeys)
			}
		})
	}
}

// declaredConfigJSONKeys lists the json tag names of the exported Config
// fields, so the key-set contract tracks the struct instead of a second list
// that can drift away from it.
func declaredConfigJSONKeys() []string {
	typ := reflect.TypeOf(Config{})
	keys := make([]string, 0, typ.NumField())
	for i := range typ.NumField() {
		field := typ.Field(i)
		if field.PkgPath != "" {
			continue // unexported loader metadata (sourcePath)
		}
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "" || name == "-" {
			continue
		}
		keys = append(keys, name)
	}
	return keys
}

// loadGolden runs LoadForEngine against a fixture. Every fixture is expired by
// construction (see goldenIssuedAt), so the loader always returns
// *ExpiredError — with Config populated, which load.go does ONLY after the
// detached signature verified and ValidateForEngine passed. Insisting on that
// exact outcome keeps the assertion strict: a fixture that lost its expires_at,
// or one whose signature stopped verifying, fails instead of falling through.
func loadGolden(t *testing.T, path string, pub ed25519.PublicKey, engine string) *Config {
	t.Helper()
	cfg, err := LoadForEngine(path, pub, false, engine)
	if err == nil {
		t.Fatalf("golden fixture is stamped %s with a 30-day TTL and must load as expired", goldenIssuedAt)
	}
	var expired *ExpiredError
	if !errors.As(err, &expired) {
		t.Fatalf("load golden fixture: %v", err)
	}
	if expired.Config == nil {
		t.Fatal("expired golden fixture must carry its verified config")
	}
	if got := expired.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z"); got != goldenExpiresAt {
		t.Fatalf("expires_at = %s, want %s", got, goldenExpiresAt)
	}
	if cfg != nil {
		t.Fatal("LoadForEngine must not return a config alongside an error")
	}
	return expired.Config
}
