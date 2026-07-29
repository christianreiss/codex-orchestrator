// Package fleetconfig fetches, verifies, and persists authoritative signed
// per-engine wrapper configs. Both persona peer reconciliation and the shared
// host cron coordinator use this one implementation.
package fleetconfig

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	coreupdate "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

var ErrEngineDisabled = errors.New("engine not enabled for host")

const fetchTimeout = 30 * time.Second

type Fetched struct {
	Config    *config.Config
	Payload   []byte
	Signature string
}

func Fetch(ctx context.Context, seed *config.Config, engine string) (*Fetched, error) {
	pubkey, err := signing.PublicKey()
	if err != nil {
		return nil, fmt.Errorf("load config signing key: %w", err)
	}
	return fetchWithKey(ctx, seed, engine, pubkey)
}

func fetchWithKey(ctx context.Context, seed *config.Config, engine string, pubkey ed25519.PublicKey) (*Fetched, error) {
	if seed == nil {
		return nil, errors.New("nil seed config")
	}
	if engine != config.EngineCodex && engine != config.EngineClaude {
		return nil, fmt.Errorf("unsupported engine %q", engine)
	}
	requestSeed := *seed
	requestSeed.Orchestrator.BaseURL = strings.TrimRight(seed.Orchestrator.BaseURL, "/")
	fetchCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet,
		requestSeed.Orchestrator.BaseURL+"/wrapper/v2/config?engine="+engine, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-API-Key", seed.Orchestrator.APIKey)
	req.Header.Set("X-Wrapper-Platform", runtime.GOOS+"-"+runtime.GOARCH)
	client, err := coreupdate.HTTPClient(seed)
	if err != nil {
		return nil, err
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s config: %w", engine, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		if responseCode(body) == "engine_disabled" {
			return nil, ErrEngineDisabled
		}
		return nil, fmt.Errorf("fetch %s config: HTTP 403 without engine_disabled confirmation", engine)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("fetch %s config: HTTP %d: %s", engine, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var envelope struct {
		Payload   json.RawMessage `json:"payload"`
		Signature struct {
			Value string `json:"value"`
		} `json:"signature"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2*1024*1024)).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("decode %s config bundle: %w", engine, err)
	}
	if len(envelope.Payload) == 0 || strings.TrimSpace(envelope.Signature.Value) == "" {
		return nil, fmt.Errorf("%s config bundle incomplete", engine)
	}
	payload := append([]byte(nil), envelope.Payload...)
	if err := config.VerifyDetached(payload, []byte(envelope.Signature.Value), pubkey); err != nil {
		return nil, fmt.Errorf("%s config signature invalid: %w", engine, err)
	}
	var cfg config.Config
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return nil, fmt.Errorf("decode signed %s config: %w", engine, err)
	}
	if err := cfg.ValidateForEngine(engine); err != nil {
		return nil, fmt.Errorf("validate signed %s config: %w", engine, err)
	}
	if cfg.Host.ID != seed.Host.ID || cfg.Host.FQDN != seed.Host.FQDN {
		return nil, fmt.Errorf("signed %s config belongs to a different host", engine)
	}
	return &Fetched{Config: &cfg, Payload: payload, Signature: envelope.Signature.Value}, nil
}

func responseCode(body []byte) string {
	var envelope struct {
		Code  string `json:"code"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
		Data struct {
			Code string `json:"code"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return ""
	}
	for _, code := range []string{envelope.Code, envelope.Error.Code, envelope.Data.Code} {
		if strings.TrimSpace(code) != "" {
			return strings.TrimSpace(code)
		}
	}
	return ""
}

// Persist atomically replaces the signed config files for one engine. The
// payload rename is last, so a concurrent reader sees either the old payload
// or the fully written new payload; signature mismatch fails closed.
func Persist(ctx context.Context, fetched *Fetched) error {
	if fetched == nil || fetched.Config == nil {
		return errors.New("nil fetched config")
	}
	path, err := config.DefaultPathForEngine(fetched.Config.Engine)
	if err != nil {
		return err
	}
	return layout.WithTargetLock(ctx, path, func() error {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		sigTmp, err := writeTemp(filepath.Dir(path), filepath.Base(path)+".sig-*", []byte(fetched.Signature))
		if err != nil {
			return err
		}
		defer os.Remove(sigTmp)
		payloadTmp, err := writeTemp(filepath.Dir(path), filepath.Base(path)+"-*", fetched.Payload)
		if err != nil {
			return err
		}
		defer os.Remove(payloadTmp)
		if err := os.Rename(sigTmp, path+".sig"); err != nil {
			return err
		}
		return os.Rename(payloadTmp, path)
	})
}

func Remove(ctx context.Context, engine string) error {
	path, err := config.DefaultPathForEngine(engine)
	if err != nil {
		return err
	}
	return layout.WithTargetLock(ctx, path, func() error {
		var errs []error
		for _, target := range []string{path, path + ".sig"} {
			if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, err)
			}
		}
		return errors.Join(errs...)
	})
}

func writeTemp(dir, pattern string, body []byte) (string, error) {
	f, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", err
	}
	path := f.Name()
	ok := false
	defer func() {
		_ = f.Close()
		if !ok {
			_ = os.Remove(path)
		}
	}()
	if err := f.Chmod(0o600); err != nil {
		return "", err
	}
	if _, err := f.Write(body); err != nil {
		return "", err
	}
	if err := f.Sync(); err != nil {
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	ok = true
	return path, nil
}
