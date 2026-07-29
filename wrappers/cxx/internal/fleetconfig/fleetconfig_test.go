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
