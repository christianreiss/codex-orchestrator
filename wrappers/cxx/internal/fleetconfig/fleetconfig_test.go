package fleetconfig

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestFetchWithKeyVerifiesExactSignedPayload(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(validConfig(config.EngineClaude, "https://example.invalid/cxx"))
	if err != nil {
		t.Fatal(err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("engine") != config.EngineClaude {
			t.Fatalf("engine query=%q", r.URL.Query().Get("engine"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"payload":   json.RawMessage(payload),
			"signature": map[string]string{"value": sig},
		})
	}))
	defer srv.Close()
	seed := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	seed.Orchestrator.BaseURL = srv.URL
	fetched, err := fetchWithKey(context.Background(), seed, config.EngineClaude, pub)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.Config.Engine != config.EngineClaude || string(fetched.Payload) != string(payload) {
		t.Fatalf("fetched=%+v payload=%q", fetched.Config, fetched.Payload)
	}
}

func TestFetchWithKeyRejectsAnotherInstallationsSignature(t *testing.T) {
	trusted, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil { t.Fatal(err) }
	_, otherPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil { t.Fatal(err) }
	payload, err := json.Marshal(validConfig(config.EngineCodex, "https://example.invalid/cxx"))
	if err != nil { t.Fatal(err) }
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(otherPrivate, payload))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"payload": json.RawMessage(payload),
			"signature": map[string]string{"value": sig},
		})
	}))
	defer srv.Close()
	seed := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	seed.Orchestrator.BaseURL = srv.URL
	if _, err := fetchWithKey(context.Background(), seed, config.EngineCodex, trusted); err == nil || !strings.Contains(err.Error(), "signature invalid") {
		t.Fatalf("error=%v, want signature invalid", err)
	}
}

func TestFetchRequiresExplicitEngineDisabledCode(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name string
		body string
		want bool
	}{
		{name: "authoritative", body: `{"code":"engine_disabled"}`, want: true},
		{name: "nested authoritative", body: `{"error":{"code":"engine_disabled"}}`, want: true},
		{name: "generic forbidden", body: `{"code":"forbidden"}`, want: false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer srv.Close()
			seed := validConfig(config.EngineCodex, "https://example.invalid/cxx")
			seed.Orchestrator.BaseURL = srv.URL
			_, err := fetchWithKey(context.Background(), seed, config.EngineClaude, pub)
			if errors.Is(err, ErrEngineDisabled) != tt.want {
				t.Fatalf("error=%v want disabled=%v", err, tt.want)
			}
		})
	}
}

func TestFetchRefusesRedirectWithoutForwardingAPIKey(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	redirected := false
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		redirected = true
		if r.Header.Get("X-API-Key") != "" {
			t.Error("API key was forwarded to redirect target")
		}
	}))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", target.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	seed := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	seed.Orchestrator.BaseURL = source.URL
	if _, err := fetchWithKey(context.Background(), seed, config.EngineClaude, pub); err == nil || !strings.Contains(err.Error(), "HTTP 307") {
		t.Fatalf("redirect accepted: %v", err)
	}
	if redirected {
		t.Fatal("redirect target was contacted")
	}
}

func TestPersistAndRemoveEngineConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "clx.json")
	t.Setenv("CLX_CONFIG_PATH", path)
	cfg := validConfig(config.EngineClaude, "https://example.invalid/cxx")
	payload, _ := json.Marshal(cfg)
	item := &Fetched{Config: cfg, Payload: payload, Signature: "signed"}
	if err := Persist(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != string(payload) {
		t.Fatalf("payload=%q err=%v", got, err)
	}
	if got, err := os.ReadFile(path + ".sig"); err != nil || string(got) != "signed" {
		t.Fatalf("signature=%q err=%v", got, err)
	}
	if err := Remove(context.Background(), config.EngineClaude); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{path, path + ".sig"} {
		if _, err := os.Stat(target); !os.IsNotExist(err) {
			t.Fatalf("%s remains: %v", target, err)
		}
	}
}

// The two writers are deliberately different: Persist resolves the engine
// default for the peer installers and the cron coordinator, PersistTo writes
// exactly where it is told for a caller that loaded from --config or
// CDX_CONFIG_PATH/CLX_CONFIG_PATH. Collapsing PersistTo back onto the default
// is the regression this pins.
func TestPersistToWritesThePathItIsGivenAndPersistTheEngineDefault(t *testing.T) {
	defaultPath := filepath.Join(t.TempDir(), "clx.json")
	t.Setenv("CLX_CONFIG_PATH", defaultPath)
	requested := filepath.Join(t.TempDir(), "elsewhere.json")

	cfg := validConfig(config.EngineClaude, "https://example.invalid/cxx")
	payload, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	item := &Fetched{Config: cfg, Payload: payload, Signature: "signed"}

	if err := PersistTo(context.Background(), requested, item); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(requested); err != nil || string(got) != string(payload) {
		t.Fatalf("payload at %s: err=%v body=%s", requested, err, got)
	}
	if got, err := os.ReadFile(requested + ".sig"); err != nil || string(got) != "signed" {
		t.Fatalf("signature at %s.sig: err=%v body=%q", requested, err, got)
	}
	if _, err := os.Stat(defaultPath); !os.IsNotExist(err) {
		t.Fatalf("PersistTo also wrote the engine default %s: %v", defaultPath, err)
	}

	if err := Persist(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(defaultPath); err != nil || string(got) != string(payload) {
		t.Fatalf("Persist did not write the engine default %s: err=%v body=%s", defaultPath, err, got)
	}

	if err := PersistTo(context.Background(), "  ", item); err == nil {
		t.Fatal("a blank path was accepted")
	}
}

// A host whose clock runs ahead sees a brand-new config as already expired.
// The fresh-fetch path must not reject it, or that host could never obtain a
// replacement for the config its clock also considers expired on disk.
func TestFetchWithKeyAcceptsAConfigThatLooksExpiredToASkewedClock(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	served := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	served.ExpiresAt = rfc3339(time.Now().Add(-time.Hour))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(signedBundle(t, served, priv))
	}))
	defer srv.Close()

	seed := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	seed.Orchestrator.BaseURL = srv.URL
	if _, err := fetchWithKey(context.Background(), seed, config.EngineCodex, pub); err != nil {
		t.Fatalf("freshly signed config rejected on arrival: %v", err)
	}
}

func TestLoadOrRecoverRefreshesAnExpiredConfig(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fresh := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	fresh.ExpiresAt = rfc3339(time.Now().Add(30 * 24 * time.Hour))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "test-api-key" {
			t.Errorf("refetch used api key %q", r.Header.Get("X-API-Key"))
		}
		_, _ = w.Write(signedBundle(t, fresh, priv))
	}))
	defer srv.Close()

	path := filepath.Join(t.TempDir(), "cdx.json")
	t.Setenv("CDX_CONFIG_PATH", path)
	stale := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	stale.Orchestrator.BaseURL = srv.URL
	stale.ExpiresAt = rfc3339(time.Now().Add(-time.Hour))
	writeSignedConfigFile(t, path, stale, priv)

	cfg, refreshed, err := LoadOrRecover(context.Background(), path, pub, config.EngineCodex)
	if err != nil {
		t.Fatalf("recovery failed: %v", err)
	}
	if !refreshed {
		t.Fatal("expected the caller to be told the config was refreshed")
	}
	if cfg.ExpiresAt == nil || *cfg.ExpiresAt != *fresh.ExpiresAt {
		t.Fatalf("expires_at=%v, want %v", cfg.ExpiresAt, *fresh.ExpiresAt)
	}
	// The replacement must be durable, not just in memory.
	reloaded, err := config.LoadForEngine(path, pub, false, config.EngineCodex)
	if err != nil {
		t.Fatalf("persisted config does not load: %v", err)
	}
	if reloaded.ExpiresAt == nil || *reloaded.ExpiresAt != *fresh.ExpiresAt {
		t.Fatalf("persisted expires_at=%v, want %v", reloaded.ExpiresAt, *fresh.ExpiresAt)
	}
}

// A host whose clock is more than a full TTL ahead of the orchestrator's sees
// even a just-issued config as expired. Refusing the replacement would hard-fail
// every invocation with no way back, so reaching the orchestrator and verifying
// its signature is what counts as proof of freshness.
func TestLoadOrRecoverAcceptsAReplacementASkewedClockStillCallsExpired(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	served := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	served.IssuedAt = time.Now().Add(-31 * 24 * time.Hour).UTC().Format(time.RFC3339)
	served.ExpiresAt = rfc3339(time.Now().Add(-time.Minute))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(signedBundle(t, served, priv))
	}))
	defer srv.Close()

	path := filepath.Join(t.TempDir(), "cdx.json")
	t.Setenv("CDX_CONFIG_PATH", path)
	stale := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	stale.Orchestrator.BaseURL = srv.URL
	stale.ExpiresAt = rfc3339(time.Now().Add(-2 * time.Hour))
	writeSignedConfigFile(t, path, stale, priv)

	cfg, refreshed, err := LoadOrRecover(context.Background(), path, pub, config.EngineCodex)
	if err != nil {
		t.Fatalf("freshly issued replacement rejected: %v", err)
	}
	if !refreshed {
		t.Fatal("expected the caller to be told the config was refreshed")
	}
	if cfg.IssuedAt != served.IssuedAt {
		t.Fatalf("issued_at=%q, want the served document %q", cfg.IssuedAt, served.IssuedAt)
	}
}

// --config and CDX_CONFIG_PATH/CLX_CONFIG_PATH let a caller load a config from
// somewhere other than the engine default. The refresh has to land on that same
// file: writing it to the default path instead leaves the reload re-reading the
// untouched expired document, which the recovery would then hand back as if it
// were fresh — refetching on every invocation and never converging.
func TestLoadOrRecoverPersistsToThePathItLoadedFrom(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fresh := validConfig(config.EngineCodex, "https://example.invalid/cxx-fresh")
	fresh.IssuedAt = time.Now().UTC().Format(time.RFC3339)
	fresh.ExpiresAt = rfc3339(time.Now().Add(30 * 24 * time.Hour))
	fresh.Wrapper.Version = "0.8.0"
	freshPayload, err := json.Marshal(fresh)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(signedBundle(t, fresh, priv))
	}))
	defer srv.Close()

	// The default path and the loaded path deliberately diverge.
	defaultPath := filepath.Join(t.TempDir(), "cdx.json")
	t.Setenv("CDX_CONFIG_PATH", defaultPath)
	path := filepath.Join(t.TempDir(), "cdx.json")
	stale := validConfig(config.EngineCodex, "https://example.invalid/cxx-stale")
	stale.Orchestrator.BaseURL = srv.URL
	stale.ExpiresAt = rfc3339(time.Now().Add(-time.Hour))
	stale.Wrapper.Version = "0.7.0"
	writeSignedConfigFile(t, path, stale, priv)

	cfg, refreshed, err := LoadOrRecover(context.Background(), path, pub, config.EngineCodex)
	if err != nil {
		t.Fatalf("recovery failed: %v", err)
	}
	if !refreshed {
		t.Fatal("expected the caller to be told the config was refreshed")
	}
	if cfg.Wrapper.Version != fresh.Wrapper.Version || cfg.Wrapper.BinaryURL != fresh.Wrapper.BinaryURL {
		t.Fatalf("returned the stale document: wrapper=%+v, want %+v", cfg.Wrapper, fresh.Wrapper)
	}
	if cfg.ExpiresAt == nil || *cfg.ExpiresAt != *fresh.ExpiresAt {
		t.Fatalf("expires_at=%v, want %v", cfg.ExpiresAt, *fresh.ExpiresAt)
	}
	if onDisk, err := os.ReadFile(path); err != nil || string(onDisk) != string(freshPayload) {
		t.Fatalf("%s was not rewritten: err=%v body=%s", path, err, onDisk)
	}
	// Nothing may be written to the engine default the caller opted out of.
	if _, err := os.Stat(defaultPath); !os.IsNotExist(err) {
		t.Fatalf("the refresh also landed on the default path %s: %v", defaultPath, err)
	}
}

// The reload verifies the detached signature, so the sidecar has to travel with
// the payload to whichever path the recovery wrote.
func TestLoadOrRecoverWritesTheSignatureSidecarBesideThePath(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fresh := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	fresh.ExpiresAt = rfc3339(time.Now().Add(30 * 24 * time.Hour))
	freshPayload, err := json.Marshal(fresh)
	if err != nil {
		t.Fatal(err)
	}
	wantSig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, freshPayload))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(signedBundle(t, fresh, priv))
	}))
	defer srv.Close()

	defaultSig := filepath.Join(t.TempDir(), "cdx.json")
	t.Setenv("CDX_CONFIG_PATH", defaultSig)
	path := filepath.Join(t.TempDir(), "cdx.json")
	stale := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	stale.Orchestrator.BaseURL = srv.URL
	stale.ExpiresAt = rfc3339(time.Now().Add(-time.Hour))
	writeSignedConfigFile(t, path, stale, priv)

	if _, _, err := LoadOrRecover(context.Background(), path, pub, config.EngineCodex); err != nil {
		t.Fatalf("recovery failed: %v", err)
	}
	sig, err := os.ReadFile(path + ".sig")
	if err != nil || string(sig) != wantSig {
		t.Fatalf("sidecar at %s.sig: err=%v body=%q want %q", path, err, sig, wantSig)
	}
	if _, err := os.Stat(defaultSig + ".sig"); !os.IsNotExist(err) {
		t.Fatalf("a sidecar also landed on the default path: %v", err)
	}
}

// The clock-skew acceptance is an anti-brick guarantee, not a licence to return
// whatever happens to sit at path. It is gated on the on-disk bytes being the
// ones just fetched, which is what keeps skew distinguishable from a refresh
// that never landed here.
func TestPersistedIsFetchedOnlyAcceptsTheDocumentJustFetched(t *testing.T) {
	dir := t.TempDir()
	fetched := &Fetched{
		Config:    validConfig(config.EngineCodex, "https://example.invalid/cxx"),
		Payload:   []byte(`{"engine":"codex"}`),
		Signature: "signed",
	}
	match := filepath.Join(dir, "match.json")
	if err := os.WriteFile(match, fetched.Payload, 0o600); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "other.json")
	if err := os.WriteFile(other, []byte(`{"engine":"codex"} `), 0o600); err != nil {
		t.Fatal(err)
	}
	if !persistedIsFetched(match, fetched) {
		t.Fatal("the freshly persisted payload was not recognised")
	}
	if persistedIsFetched(other, fetched) {
		t.Fatal("a different document was accepted as the freshly persisted one")
	}
	if persistedIsFetched(filepath.Join(dir, "absent.json"), fetched) {
		t.Fatal("a missing file was accepted as the freshly persisted one")
	}
}

// The refetch seed's base_url and api_key are attacker-controlled unless the
// signature verified first, so an unverifiable config must never reach the network.
func TestLoadOrRecoverNeverSeedsFromAnUnverifiableConfig(t *testing.T) {
	trusted, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, forged, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	contacted := false
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		contacted = true
	}))
	defer srv.Close()

	path := filepath.Join(t.TempDir(), "cdx.json")
	t.Setenv("CDX_CONFIG_PATH", path)
	stale := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	stale.Orchestrator.BaseURL = srv.URL
	stale.ExpiresAt = rfc3339(time.Now().Add(-time.Hour))
	writeSignedConfigFile(t, path, stale, forged)

	_, refreshed, err := LoadOrRecover(context.Background(), path, trusted, config.EngineCodex)
	if err == nil || !strings.Contains(err.Error(), "signature invalid") {
		t.Fatalf("error=%v, want signature invalid", err)
	}
	if errors.Is(err, config.ErrExpired) {
		t.Fatal("an unverifiable config must fail as untrusted, not as expired")
	}
	if refreshed || contacted {
		t.Fatalf("refreshed=%v contacted=%v: unverified credentials were used", refreshed, contacted)
	}
}

func TestLoadOrRecoverReportsTheOperatorProcedureWhenRefreshFails(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	path := filepath.Join(t.TempDir(), "cdx.json")
	t.Setenv("CDX_CONFIG_PATH", path)
	stale := validConfig(config.EngineCodex, "https://example.invalid/cxx")
	stale.Orchestrator.BaseURL = srv.URL
	stale.ExpiresAt = rfc3339(time.Now().Add(-time.Hour))
	writeSignedConfigFile(t, path, stale, priv)

	_, _, err = LoadOrRecover(context.Background(), path, pub, config.EngineCodex)
	if !errors.Is(err, config.ErrExpired) {
		t.Fatalf("error=%v, want it to stay an expiry failure", err)
	}
	if !strings.Contains(err.Error(), "re-run the host installer") || !strings.Contains(err.Error(), path) {
		t.Fatalf("error=%v, want the operator procedure and the config path", err)
	}
	// The instruction has to survive the ~240-char truncation the CLI applies.
	if idx := strings.Index(err.Error(), "re-run the host installer"); idx > 120 {
		t.Fatalf("operator instruction starts at %d, too late to survive truncation: %v", idx, err)
	}
}

func rfc3339(at time.Time) *string {
	formatted := at.UTC().Format(time.RFC3339)
	return &formatted
}

func writeSignedConfigFile(t *testing.T, path string, cfg *config.Config, priv ed25519.PrivateKey) {
	t.Helper()
	payload, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))
	if err := os.WriteFile(path+".sig", []byte(sig), 0o600); err != nil {
		t.Fatal(err)
	}
}

func signedBundle(t *testing.T, cfg *config.Config, priv ed25519.PrivateKey) []byte {
	t.Helper()
	payload, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"payload":   json.RawMessage(payload),
		"signature": map[string]string{"value": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))},
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func validConfig(engine, binaryURL string) *config.Config {
	return &config.Config{
		SchemaVersion: config.SchemaVersion,
		Engine:        engine,
		Orchestrator: config.Orchestrator{
			BaseURL: "https://orchestrator.example.com",
			APIKey:  "test-api-key",
		},
		Host: config.Host{ID: 7, FQDN: "host.example.com"},
		Wrapper: config.Wrapper{
			Version:      "0.7.0",
			BinaryURL:    binaryURL,
			BinarySHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
	}
}
