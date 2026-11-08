// Package rtk manages the optional, external RTK OSS command filter.
package rtk

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

const Version = "1.2.0"
const archiveLimit = 64 << 20
const binaryLimit = 128 << 20

func root() (string, error) { h, e := os.UserHomeDir(); return filepath.Join(h, ".cxx", "rtk"), e }
func binaryPath() (string, error) {
	r, e := root()
	return filepath.Join(r, Version, runtime.GOOS+"-"+runtime.GOARCH, "rtk"), e
}

// Install verifies the signed policy's archive before extracting its one regular
// executable. No archive paths, links or configuration files are installed.
func Install(ctx context.Context, cfg *config.Config) (string, error) {
	if cfg == nil || cfg.RTK == nil || cfg.RTK.Version != Version || cfg.RTK.Protocol != 1 {
		return "", errors.New("unsupported_policy")
	}
	dest, err := binaryPath()
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(dest)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(dir, ".install.lock"))
	if err != nil {
		return "", err
	}
	defer lock.Release()
	a, ok := cfg.RTK.Artifacts[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok || len(a.SHA256) != 64 {
		return "", errors.New("unsupported_platform")
	}
	if verifiedCache(dest, a.SHA256) {
		return dest, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", a.URL, nil)
	if err != nil {
		return "", errors.New("invalid_artifact")
	}
	// Credentials are only attached to the orchestrator's same-origin mirror.
	if !strings.HasPrefix(a.URL, strings.TrimRight(cfg.Orchestrator.BaseURL, "/")+"/wrapper/v2/rtk/") {
		return "", errors.New("invalid_artifact")
	}
	req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	communicator.SetAPIHeader(req.Header)
	client, err := update.HTTPClient(cfg)
	if err != nil {
		return "", err
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return "", errors.New("download_failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download_failed: HTTP %d", resp.StatusCode)
	}
	tmp, err := os.CreateTemp(dir, "archive-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, archiveLimit+1))
	if err != nil || n > archiveLimit {
		return "", errors.New("invalid_archive")
	}
	if hex.EncodeToString(h.Sum(nil)) != strings.ToLower(a.SHA256) {
		return "", errors.New("checksum_mismatch")
	}
	if _, err = tmp.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	gz, err := gzip.NewReader(tmp)
	if err != nil {
		return "", errors.New("invalid_archive")
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var binary []byte
	for {
		entry, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return "", errors.New("invalid_archive")
		}
		if filepath.Base(entry.Name) != "rtk" {
			continue
		}
		if binary != nil || entry.Typeflag != tar.TypeReg || entry.Size <= 0 || entry.Size > binaryLimit {
			return "", errors.New("invalid_archive")
		}
		binary, e = io.ReadAll(io.LimitReader(tr, binaryLimit+1))
		if e != nil || len(binary) > binaryLimit {
			return "", errors.New("invalid_archive")
		}
	}
	if len(binary) == 0 {
		return "", errors.New("invalid_archive")
	}
	stage, err := os.CreateTemp(dir, "binary-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(stage.Name())
	if _, err = stage.Write(binary); err == nil {
		err = stage.Chmod(0700)
	}
	closeErr := stage.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err = os.Rename(stage.Name(), dest); err != nil {
		return "", err
	}
	sum := sha256.Sum256(binary)
	if err = os.WriteFile(dest+".sha256", []byte(a.SHA256+":"+hex.EncodeToString(sum[:])), 0600); err != nil {
		return "", err
	}
	return dest, nil
}

func verifiedCache(path, archiveSHA string) bool {
	raw, e := os.ReadFile(path + ".sha256")
	if e != nil {
		return false
	}
	parts := strings.Split(string(raw), ":")
	if len(parts) != 2 || parts[0] != archiveSHA {
		return false
	}
	f, e := os.Open(path)
	if e != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	_, e = io.Copy(h, io.LimitReader(f, binaryLimit+1))
	return e == nil && parts[1] == hex.EncodeToString(h.Sum(nil))
}

// Sync prepares the optional pinned artifact without creating a native session.
func Sync(ctx context.Context, cfg *config.Config) error {
	if cfg == nil || cfg.RTK == nil || !cfg.RTK.Enabled || cfg.EngineSuspended(cfg.Engine) {
		return nil
	}
	_, err := Install(ctx, cfg)
	if err != nil {
		report(ctx, cfg, false, errorCode(err), "", "")
	}
	return err
}
