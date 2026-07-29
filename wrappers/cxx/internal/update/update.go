// Package update is the one implementation for downloading, validating, and
// atomically installing the shared cxx artifact. Persona packages retain only
// their engine-specific re-exec/auth handoff.
package update

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
)

const (
	downloadTimeout = 5 * time.Minute
	maxBinarySize   = 500 * 1024 * 1024
)

func Install(ctx context.Context, cfg *config.Config, binaryURL, expectedSHA, targetVersion string, logger *slog.Logger) (string, error) {
	if cfg == nil {
		return "", errors.New("nil wrapper config")
	}
	if err := validateExpectedSHA(expectedSHA); err != nil {
		return "", err
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve self path: %w", err)
	}
	dest, err := layout.CanonicalExecutable(exe)
	if err != nil {
		return "", fmt.Errorf("resolve canonical wrapper path: %w", err)
	}
	logger.Info("cxx update starting", "target_version", targetVersion, "url", binaryURL, "platform", runtime.GOOS+"/"+runtime.GOARCH)

	downloadCtx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(downloadCtx, http.MethodGet, binaryURL, nil)
	if err != nil {
		return "", err
	}
	if cfg.Orchestrator.APIKey != "" && sameHost(binaryURL, cfg.Orchestrator.BaseURL) {
		req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	}
	req.Header.Set("User-Agent", "cxx-update/"+targetVersion)
	client, err := HTTPClient(cfg)
	if err != nil {
		return "", err
	}
	client.CheckRedirect = safeRedirect
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("download binary: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("download binary: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	tmp, err := os.CreateTemp("", "cxx-wrapper-*.new")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o755); err != nil {
		_ = tmp.Close()
		return "", err
	}
	written, err := io.Copy(tmp, io.LimitReader(resp.Body, maxBinarySize+1))
	if err != nil {
		_ = tmp.Close()
		return "", err
	}
	if written > maxBinarySize {
		_ = tmp.Close()
		return "", fmt.Errorf("download binary exceeds %d bytes", maxBinarySize)
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := VerifyChecksum(tmpPath, expectedSHA); err != nil {
		return "", err
	}
	if err := verifyExecutable(downloadCtx, tmpPath); err != nil {
		return "", err
	}
	if err := layout.WithTargetLock(ctx, dest, func() error {
		// A concurrent persona may already have installed the same common bytes.
		if VerifyChecksum(dest, expectedSHA) == nil {
			return nil
		}
		return InstallVerifiedBinary(tmpPath, dest)
	}); err != nil {
		return "", err
	}
	logger.Info("cxx update complete", "version", targetVersion, "path", dest)
	return dest, nil
}

func safeRedirect(next *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	if len(via) > 0 {
		origin := via[0].URL
		if !strings.EqualFold(next.URL.Host, origin.Host) ||
			(strings.EqualFold(origin.Scheme, "https") && strings.EqualFold(next.URL.Scheme, "http")) {
			next.Header.Del("X-API-Key")
		}
	}
	return nil
}

func VerifyChecksum(path, expected string) error {
	if err := validateExpectedSHA(expected); err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, strings.TrimSpace(expected)) {
		return fmt.Errorf("sha256 mismatch: got %s, expected %s", got, expected)
	}
	return nil
}

func validateExpectedSHA(expected string) error {
	expected = strings.TrimSpace(expected)
	if len(expected) != 64 {
		return errors.New("expected sha256 must be 64 hex chars")
	}
	if _, err := hex.DecodeString(expected); err != nil {
		return errors.New("expected sha256 must be 64 hex chars")
	}
	return nil
}

func InstallVerifiedBinary(source, dest string) error {
	if err := layout.InstallAtomic(source, dest); err != nil {
		return fmt.Errorf("atomic swap failed: %w", err)
	}
	return nil
}

func verifyExecutable(ctx context.Context, path string) error {
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(checkCtx, path, "--version").CombinedOutput()
	if err != nil {
		return fmt.Errorf("new cxx failed --version sanity check: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// HTTPClient returns the wrapper's common orchestrator client, including the
// configured private CA and explicit insecure-mode policy.
func HTTPClient(cfg *config.Config) (*http.Client, error) {
	tlsConfig := &tls.Config{InsecureSkipVerify: cfg.Orchestrator.AllowInsecure}
	if cfg.Orchestrator.CABundlePath != nil && strings.TrimSpace(*cfg.Orchestrator.CABundlePath) != "" {
		pem, err := os.ReadFile(*cfg.Orchestrator.CABundlePath)
		if err != nil {
			return nil, fmt.Errorf("read CA bundle: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("CA bundle contains no certificates")
		}
		tlsConfig.RootCAs = pool
	}
	return &http.Client{Timeout: downloadTimeout, Transport: &http.Transport{TLSClientConfig: tlsConfig}}, nil
}

func sameHost(rawURL, baseURL string) bool {
	a, errA := url.Parse(rawURL)
	b, errB := url.Parse(baseURL)
	return errA == nil && errB == nil && strings.EqualFold(a.Host, b.Host)
}
