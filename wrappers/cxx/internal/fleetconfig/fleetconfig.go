// Package fleetconfig fetches, verifies, and persists authoritative signed
// per-engine wrapper configs. Both persona peer reconciliation and the shared
// host cron coordinator use this one implementation.
package fleetconfig

import (
	"bytes"
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

// LoadOrRecover loads engine's signed config from path and self-heals the one
// failure an operator cannot repair remotely: an expired config.
//
// Expiry is not tampering. config.LoadForEngine attaches the parsed document to
// *config.ExpiredError only after its detached signature verified, so an
// expired config's orchestrator.base_url and api_key are still authentic and
// may seed exactly one refetch. Every other load failure — missing file, bad
// signature, wrong engine — is returned untouched and never seeds anything.
//
// The bool reports whether a refresh happened so the caller can tell the
// operator the config was renewed underneath them.
func LoadOrRecover(ctx context.Context, path string, pubkey ed25519.PublicKey, engine string) (*config.Config, bool, error) {
	cfg, err := config.LoadForEngine(path, pubkey, false, engine)
	if err == nil {
		return cfg, false, nil
	}
	var expired *config.ExpiredError
	if !errors.As(err, &expired) || expired.Config == nil {
		return nil, false, err
	}
	fetched, fetchErr := fetchWithKey(ctx, expired.Config, engine, pubkey)
	if fetchErr != nil {
		return nil, false, expiredRecoveryError(expired, path, fetchErr)
	}
	// Persist to the path we loaded from, not to the engine default: a caller
	// that passed --config/CDX_CONFIG_PATH would otherwise refresh a different
	// file and reload the untouched expired one forever.
	if persistErr := PersistTo(ctx, path, fetched); persistErr != nil {
		return nil, false, expiredRecoveryError(expired, path, persistErr)
	}
	// Reload rather than returning the fetched config: it proves the bytes that
	// landed on disk verify and validate, and it is what stamps the source path
	// long-running capabilities re-read later.
	cfg, reloadErr := config.LoadForEngine(path, pubkey, false, engine)
	if reloadErr != nil {
		var stillExpired *config.ExpiredError
		// Accept a still-expired reload ONLY when the document on disk is
		// byte-for-byte the one the orchestrator just signed for us. Then it is
		// as fresh as a config can be, and a host clock more than a full TTL
		// ahead of the server's is the only thing that can call it expired;
		// refusing it would brick the host on every invocation with no way
		// back, and reaching the orchestrator is the stronger freshness proof.
		// Any other still-expired document means the refresh did not land here,
		// and returning it would silently run on a stale config instead.
		if errors.As(reloadErr, &stillExpired) && stillExpired.Config != nil && persistedIsFetched(path, fetched) {
			return stillExpired.Config, true, nil
		}
		return nil, false, expiredRecoveryError(expired, path, reloadErr)
	}
	return cfg, true, nil
}

// persistedIsFetched reports whether path holds exactly the payload just
// fetched. It is what separates genuine clock skew from a refreshed config that
// never reached path, so the anti-brick acceptance can never cover a stale read.
func persistedIsFetched(path string, fetched *Fetched) bool {
	if fetched == nil {
		return false
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return bytes.Equal(onDisk, fetched.Payload)
}

// expiredRecoveryError leads with the operator instruction and trails with the
// cause: the rendered failure is truncated to a couple of hundred characters,
// and a verbose transport error must not be what survives.
func expiredRecoveryError(expired *config.ExpiredError, path string, cause error) error {
	return fmt.Errorf("%w: re-run the host installer to reseed %s; automatic refresh failed: %v",
		expired, path, cause)
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

// Persist atomically replaces the signed config files at the engine's default
// location.
func Persist(ctx context.Context, fetched *Fetched) error {
	if fetched == nil || fetched.Config == nil {
		return errors.New("nil fetched config")
	}
	path, err := config.DefaultPathForEngine(fetched.Config.Engine)
	if err != nil {
		return err
	}
	return PersistTo(ctx, path, fetched)
}

// PersistTo atomically replaces the signed config files at path. The payload
// rename is last, so a concurrent reader sees either the old payload or the
// fully written new payload; signature mismatch fails closed.
func PersistTo(ctx context.Context, path string, fetched *Fetched) error {
	if fetched == nil || fetched.Config == nil {
		return errors.New("nil fetched config")
	}
	if strings.TrimSpace(path) == "" {
		return errors.New("empty config path")
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
