package communicator

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/httpguard"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

// The engine hint selects validation only; the loader verifies the entire
// signed file before any field is used as configuration.
func loadSigned(path string, key ed25519.PublicKey) (*config.Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var hint struct {
		Engine string `json:"engine"`
	}
	if err := json.Unmarshal(raw, &hint); err != nil {
		return nil, err
	}
	return config.LoadForEngine(path, key, false, hint.Engine)
}

// The shared owner outlives any one engine. Keep the current config preferred,
// but allow another signed scope to supply transport policy after its removal
// or disablement. Never change the host/server identity that elected the owner.
func selectSignedConfig(seed *config.Config, paths []string, key ed25519.PublicKey) (*config.Config, error) {
	paths = append([]string{seed.SourcePath()}, paths...)
	for _, engine := range []string{"codex", "claude", "grok"} {
		if path, err := config.DefaultPathForEngine(engine); err == nil {
			paths = append(paths, path)
		}
	}
	seen := map[string]bool{}
	var rollback *config.Config
	var firstErr error
	for _, path := range paths {
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		cfg, err := loadSigned(path, key)
		if err == nil && (cfg.Host.ID != seed.Host.ID || cfg.Host.FQDN != seed.Host.FQDN || strings.TrimRight(cfg.Orchestrator.BaseURL, "/") != strings.TrimRight(seed.Orchestrator.BaseURL, "/")) {
			err = fmt.Errorf("communicator config belongs to another host or server")
		}
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if cfg.Orchestrator.CommunicatorProtocol == Protocol && !cfg.EngineSuspended(cfg.Engine) {
			return cfg, nil
		}
		if cfg.Orchestrator.CommunicatorProtocol != Protocol && rollback == nil {
			rollback = cfg
		}
	}
	if rollback != nil {
		return rollback, nil
	}
	if firstErr == nil {
		firstErr = fmt.Errorf("no enabled signed communicator config for this host")
	}
	return nil, firstErr
}

func (s *server) reloadConfig(key ed25519.PublicKey) (*config.Config, error) {
	s.mu.Lock()
	seed := s.cfg
	paths := make([]string, 0, len(s.jobs))
	for id, job := range s.jobs {
		if s.jobRefs[id] > 0 {
			paths = append(paths, job.Config)
		}
	}
	s.mu.Unlock()
	sort.Strings(paths)
	return selectSignedConfig(seed, paths, key)
}

// A failed WebSocket is never permission to downgrade. Only a freshly verified
// host config can disable the transport and permit the existing HTTPS path.
func (s *server) refreshPolicy(ctx context.Context) {
	work, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cfg := s.configSnapshot()
	transport, err := directTransport(cfg)
	if err != nil {
		return
	}
	defer transport.CloseIdleConnections()
	req, err := http.NewRequestWithContext(work, "GET", strings.TrimRight(cfg.Orchestrator.BaseURL, "/")+"/wrapper/v2/config?engine="+cfg.Engine, nil)
	if err != nil {
		return
	}
	req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	SetAPIHeader(req.Header)
	res, err := (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return
	}
	raw, err := httpguard.ReadLimit(res.Body, 2*1024*1024)
	if err != nil {
		return
	}
	disabled, err := verifiedPolicy(raw, cfg)
	if err != nil {
		return
	}
	s.mu.Lock()
	s.fallback = disabled
	s.mu.Unlock()
}
func verifiedPolicy(raw []byte, seed *config.Config) (bool, error) {
	var envelope struct {
		Payload   json.RawMessage `json:"payload"`
		Signature struct {
			Value string `json:"value"`
		} `json:"signature"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return false, err
	}
	if len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, &envelope); err != nil {
			return false, err
		}
	}
	key, err := signing.PublicKey()
	if err != nil {
		return false, err
	}
	if err := config.VerifyDetached(envelope.Payload, []byte(envelope.Signature.Value), key); err != nil {
		return false, err
	}
	var cfg config.Config
	if err := json.Unmarshal(envelope.Payload, &cfg); err != nil {
		return false, err
	}
	if err := cfg.ValidateForEngine(seed.Engine); err != nil {
		return false, err
	}
	if cfg.Host.ID != seed.Host.ID || cfg.Host.FQDN != seed.Host.FQDN || cfg.Orchestrator.BaseURL != seed.Orchestrator.BaseURL {
		return false, fmt.Errorf("communicator policy belongs to another host")
	}
	return cfg.Orchestrator.CommunicatorProtocol != Protocol, nil
}
