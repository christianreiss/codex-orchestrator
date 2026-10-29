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
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/httpguard"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipv4"
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

	// The communicator updater prefetches the verified artifact while agents
	// run; applying it later is then a local swap.
	if staged, err := StagedPath(expectedSHA); err == nil && VerifyChecksum(staged, expectedSHA) == nil {
		if err := verifyExecutable(ctx, staged); err == nil {
			if err := layout.WithTargetLock(ctx, dest, func() error {
				if VerifyChecksum(dest, expectedSHA) == nil {
					return nil
				}
				return InstallVerifiedBinary(staged, dest)
			}); err != nil {
				return "", err
			}
			logger.Info("cxx update complete from staged artifact", "version", targetVersion, "path", dest)
			return dest, nil
		}
	}

	downloadCtx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(downloadCtx, http.MethodGet, binaryURL, nil)
	if err != nil {
		return "", err
	}
	if cfg.Orchestrator.APIKey != "" && sameHost(binaryURL, cfg.Orchestrator.BaseURL) {
		req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
		communicator.SetAPIHeader(req.Header)
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

	stageDirs := updateStageDirs(dest)
	tmp, stageIndex, err := createStageFile(stageDirs)
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o755); err != nil {
		_ = tmp.Close()
		return "", err
	}
	written, err := io.Copy(tmp, io.LimitReader(updateprogress.Reader(ctx, resp.Body, resp.ContentLength), maxBinarySize+1))
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
	updateprogress.Emit(ctx, updateprogress.Event{Phase: "verifying"})
	if err := VerifyChecksum(tmpPath, expectedSHA); err != nil {
		return "", err
	}
	checkedPath, cleanup, err := verifyStagedExecutable(downloadCtx, tmpPath, stageDirs[stageIndex+1:])
	defer cleanup()
	if err != nil {
		return "", err
	}
	tmpPath = checkedPath
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

// StagedPath names the prefetch location of an artifact: per user, private,
// never under a shared temporary directory.
func StagedPath(expectedSHA string) (string, error) {
	if err := validateExpectedSHA(expectedSHA); err != nil {
		return "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cxx", "staging", "cxx-"+strings.ToLower(strings.TrimSpace(expectedSHA))), nil
}

// Prefetch downloads and verifies an artifact into its staged path without
// installing it. An already staged, verified copy is reused. Older staged
// artifacts are removed once a new one is in place.
func Prefetch(ctx context.Context, cfg *config.Config, binaryURL, expectedSHA, targetVersion string) (string, error) {
	if cfg == nil {
		return "", errors.New("nil wrapper config")
	}
	dest, err := StagedPath(expectedSHA)
	if err != nil {
		return "", err
	}
	if VerifyChecksum(dest, expectedSHA) == nil {
		return dest, nil
	}
	dir := filepath.Dir(dest)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	downloadCtx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(downloadCtx, http.MethodGet, binaryURL, nil)
	if err != nil {
		return "", err
	}
	if cfg.Orchestrator.APIKey != "" && sameHost(binaryURL, cfg.Orchestrator.BaseURL) {
		req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
		communicator.SetAPIHeader(req.Header)
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
		return "", fmt.Errorf("download binary: HTTP %d", resp.StatusCode)
	}
	tmp, err := os.CreateTemp(dir, ".cxx-*.part")
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
	if err == nil && written > maxBinarySize {
		err = fmt.Errorf("download binary exceeds %d bytes", maxBinarySize)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if err := VerifyChecksum(tmpPath, expectedSHA); err != nil {
		return "", err
	}
	if err := verifyExecutable(downloadCtx, tmpPath); err != nil {
		return "", err
	}
	if err := os.Rename(tmpPath, dest); err != nil {
		return "", err
	}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, entry := range entries {
			if name := entry.Name(); strings.HasPrefix(name, "cxx-") && filepath.Join(dir, name) != dest {
				_ = os.Remove(filepath.Join(dir, name))
			}
		}
	}
	return dest, nil
}

func safeRedirect(next *http.Request, via []*http.Request) error {
	return httpguard.ArtifactRedirect(next, via)
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

// updateStageDirs lists where a downloaded candidate is written and executed
// for its --version check, in order of preference: beside the install target
// (same filesystem, and it already holds an executable cxx), then the private
// per-user staging directory, and only last the system temporary directory,
// which hardened hosts mount noexec.
func updateStageDirs(dest string) []stageDir {
	dirs := []stageDir{{path: filepath.Dir(dest)}}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		dirs = append(dirs, stageDir{path: filepath.Join(home, ".cxx", "staging"), create: true})
	}
	return append(dirs, stageDir{path: os.TempDir()})
}

// stageDir is one candidate staging location. Only the private per-user
// staging directory is ever created; the others must already exist.
type stageDir struct {
	path   string
	create bool
}

// createStageFile creates a private temporary file in the first writable
// directory of dirs and reports which one it used.
func createStageFile(dirs []stageDir) (*os.File, int, error) {
	var errs []error
	for i, dir := range dirs {
		if err := ensureStageDir(dir); err != nil {
			errs = append(errs, err)
			continue
		}
		f, err := os.CreateTemp(dir.path, ".cxx-wrapper-*.new")
		if err == nil {
			return f, i, nil
		}
		errs = append(errs, err)
	}
	return nil, -1, fmt.Errorf("no writable staging directory for the cxx update: %w", errors.Join(errs...))
}

func ensureStageDir(dir stageDir) error {
	info, err := os.Stat(dir.path)
	if err == nil {
		if !info.IsDir() {
			return fmt.Errorf("%s is not a directory", dir.path)
		}
		return nil
	}
	if !dir.create {
		return err
	}
	return os.MkdirAll(dir.path, 0o700)
}

// verifyStagedExecutable runs the --version sanity check on path. When the
// kernel refuses to execute it (a noexec mount), the verified bytes are copied
// to the next candidate directory and checked there. It returns the path that
// passed and a cleanup for any extra copy it made.
func verifyStagedExecutable(ctx context.Context, path string, fallbacks []stageDir) (string, func(), error) {
	var copies []string
	cleanup := func() {
		for _, p := range copies {
			_ = os.Remove(p)
		}
	}
	err := verifyExecutable(ctx, path)
	for err != nil && errors.Is(err, fs.ErrPermission) && len(fallbacks) > 0 {
		dir := fallbacks[0]
		fallbacks = fallbacks[1:]
		next, cerr := copyToStageDir(path, dir)
		if cerr != nil {
			continue
		}
		copies = append(copies, next)
		path = next
		err = verifyExecutable(ctx, path)
	}
	if err != nil {
		return "", cleanup, err
	}
	return path, cleanup, nil
}

func copyToStageDir(source string, dir stageDir) (string, error) {
	if err := ensureStageDir(dir); err != nil {
		return "", err
	}
	in, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.CreateTemp(dir.path, ".cxx-wrapper-*.new")
	if err != nil {
		return "", err
	}
	name := out.Name()
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Chmod(0o755)
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(name)
		return "", err
	}
	return name, nil
}

func verifyExecutable(ctx context.Context, path string) error {
	return runVersionCheck(ctx, path)
}

var runVersionCheck = func(ctx context.Context, path string) error {
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
	return &http.Client{Timeout: downloadTimeout, CheckRedirect: httpguard.Redirect, Transport: communicator.Wrap(&http.Transport{DialContext: ipv4.PreferDialContext(), TLSClientConfig: tlsConfig})}, nil
}

func sameHost(rawURL, baseURL string) bool {
	a, errA := url.Parse(rawURL)
	b, errB := url.Parse(baseURL)
	return errA == nil && errB == nil && httpguard.SameOrigin(a, b)
}
