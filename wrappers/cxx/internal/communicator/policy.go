package communicator

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
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
	res, err := (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 2*1024*1024))
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
