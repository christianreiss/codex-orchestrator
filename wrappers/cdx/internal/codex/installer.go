// Package codex includes installer.go which handles installing or updating
// the upstream `codex` CLI from either npm-global (`codex-cli` package) or
// the GitHub releases tarball pipeline. The latter mirrors the legacy bash
// wrapper at git fe70ac3:bin/cdx.d/04-update.sh.
package codex

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// githubBaseURL is the GitHub REST host. Overridable for tests.
var githubBaseURL = "https://api.github.com"

// EnsureCodex makes sure the locally-installed Codex CLI is at the target
// version. Detection rules:
//
//  1. If `codex` is on PATH AND `npm ls -g codex-cli` returns ok → npm path.
//  2. Otherwise → GitHub release asset path for the current host arch.
//
// When enforceExact is false and the local version already equals target,
// the call is a no-op.
func EnsureCodex(ctx context.Context, target string, enforceExact bool, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}

	current := strings.TrimSpace(Version(ctx))
	if !enforceExact && current != "" && current != "unknown" && current == target {
		logger.Debug("EnsureCodex: already at target", "version", current)
		return nil
	}

	if isManagedByNpm(ctx) {
		return ensureCodexNpm(ctx, target, enforceExact, logger)
	}
	return ensureCodexGitHub(ctx, target, enforceExact, current, logger)
}

// isManagedByNpm returns true when an upstream `codex` binary is on PATH AND
// `npm ls -g codex-cli` reports it as installed.
func isManagedByNpm(ctx context.Context) bool {
	if _, err := FindCLI(); err != nil {
		return false
	}
	if _, err := exec.LookPath("npm"); err != nil {
		return false
	}
	cmd := exec.CommandContext(ctx, "npm", "ls", "-g", "codex-cli")
	if err := cmd.Run(); err != nil {
		return false
	}
	return true
}

func ensureCodexNpm(ctx context.Context, target string, enforceExact bool, logger *slog.Logger) error {
	spec := "codex-cli"
	if target != "" && target != "latest" {
		spec = "codex-cli@" + target
	}
	logger.Debug("EnsureCodex: npm install", "spec", spec, "enforce_exact", enforceExact)

	args := []string{"install", "-g", spec}
	cmd := exec.CommandContext(ctx, "npm", args...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		cacheInstalledCodexNpm(ctx)
		return nil
	}
	// Permission failure → retry under sudo when available (non-interactive).
	if isPermErr(out, err) {
		if _, lerr := exec.LookPath("sudo"); lerr == nil {
			logger.Debug("EnsureCodex: retrying npm install under sudo -n")
			args = append([]string{"-n", "npm"}, args...)
			cmd = exec.CommandContext(ctx, "sudo", args...)
			out2, serr := cmd.CombinedOutput()
			if serr == nil {
				cacheInstalledCodexNpm(ctx)
				return nil
			}
			return fmt.Errorf("npm install %s failed under sudo: %w: %s", spec, serr, strings.TrimSpace(string(out2)))
		}
	}
	return fmt.Errorf("npm install %s failed: %w: %s", spec, err, strings.TrimSpace(string(out)))
}

// cacheInstalledCodexNpm resolves the codex binary path via npm's global bin
// dir and writes it to the cache so cron and restricted-PATH environments can
// find it without a full PATH scan.
func cacheInstalledCodexNpm(ctx context.Context) {
	out, err := exec.CommandContext(ctx, "npm", "bin", "-g").Output()
	if err == nil {
		p := filepath.Join(strings.TrimSpace(string(out)), "codex")
		if _, serr := os.Stat(p); serr == nil {
			_ = cacheCodex(p)
			return
		}
	}
	if p, lerr := exec.LookPath("codex"); lerr == nil {
		_ = cacheCodex(p)
	}
}

func isPermErr(out []byte, err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(string(out))
	return strings.Contains(s, "eacces") ||
		strings.Contains(s, "permission denied") ||
		strings.Contains(s, "operation not permitted")
}

// --- GitHub release path ---------------------------------------------------

// Asset is a single binary attachment from a GitHub release.
type Asset struct {
	Name        string `json:"name"`
	DownloadURL string `json:"browser_download_url"`
	Digest      string `json:"digest"` // typically "sha256:<hex>"
	Size        int64  `json:"size"`
}

// Release is the subset of a GitHub release we consume.
type Release struct {
	Name    string  `json:"name"`
	TagName string  `json:"tag_name"`
	Assets  []Asset `json:"assets"`
}

// pickAsset returns the asset for the host platform. Selection rules
// mirror the legacy bash wrapper's detect_codex_asset_name logic:
//
//	linux/amd64  → codex-x86_64-unknown-linux-musl*  (prefer .tar.gz)
//	linux/arm64  → codex-aarch64-unknown-linux-musl*
//	darwin/arm64 → codex-aarch64-apple-darwin*
//	darwin/amd64 → codex-x86_64-apple-darwin*
//
// Windows is out of scope.
func pickAsset(rel Release, goos, goarch string) (Asset, error) {
	prefix, err := assetPrefix(goos, goarch)
	if err != nil {
		return Asset{}, err
	}

	var match Asset
	var tarball Asset
	var matched, tarballFound bool
	for _, a := range rel.Assets {
		if !strings.HasPrefix(a.Name, prefix) {
			continue
		}
		matched = true
		if strings.HasSuffix(a.Name, ".tar.gz") {
			tarball = a
			tarballFound = true
		} else if match.Name == "" {
			match = a
		}
	}
	if tarballFound {
		return tarball, nil
	}
	if matched {
		return match, nil
	}
	return Asset{}, fmt.Errorf("no release asset matches %s for %s/%s", prefix, goos, goarch)
}

func assetPrefix(goos, goarch string) (string, error) {
	switch goos + "/" + goarch {
	case "linux/amd64":
		return "codex-x86_64-unknown-linux-musl", nil
	case "linux/arm64":
		return "codex-aarch64-unknown-linux-musl", nil
	case "darwin/arm64":
		return "codex-aarch64-apple-darwin", nil
	case "darwin/amd64":
		return "codex-x86_64-apple-darwin", nil
	default:
		return "", fmt.Errorf("unsupported platform %s/%s", goos, goarch)
	}
}

// fetchRelease pulls a single release (by tag or latest) from the GitHub API.
// target == "" or "latest" hits /releases/latest; anything else hits
// /releases/tags/<target> with a few semver-prefix fallbacks.
func fetchRelease(ctx context.Context, target string) (Release, error) {
	candidates := releaseTagCandidates(target)
	var lastErr error
	for _, tag := range candidates {
		url := githubBaseURL + "/repos/openai/codex" + tag
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return Release{}, err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", "cdx-wrapper-update-check")
		client := &http.Client{Timeout: 20 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
		resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			lastErr = fmt.Errorf("github release not found: %s", url)
			continue
		}
		if resp.StatusCode >= 400 {
			lastErr = fmt.Errorf("github %s -> %d: %s", url, resp.StatusCode, strings.TrimSpace(string(body)))
			continue
		}
		var rel Release
		if err := json.Unmarshal(body, &rel); err != nil {
			return Release{}, fmt.Errorf("parse release: %w", err)
		}
		return rel, nil
	}
	if lastErr == nil {
		lastErr = errors.New("github release: no candidate URLs")
	}
	return Release{}, lastErr
}

// releaseTagCandidates returns the GitHub release URL suffixes to try.
// Mirrors the legacy bash fallback chain.
func releaseTagCandidates(target string) []string {
	t := strings.TrimSpace(target)
	if t == "" || t == "latest" {
		return []string{"/releases/latest"}
	}
	seen := map[string]struct{}{}
	out := []string{}
	add := func(tag string) {
		if tag == "" {
			return
		}
		if _, ok := seen[tag]; ok {
			return
		}
		seen[tag] = struct{}{}
		out = append(out, "/releases/tags/"+tag)
	}
	add(t)
	if !strings.HasPrefix(t, "v") {
		add("v" + t)
	}
	add("rust-" + t)
	add("rust-v" + t)
	return out
}

func ensureCodexGitHub(ctx context.Context, target string, enforceExact bool, current string, logger *slog.Logger) error {
	rel, err := fetchRelease(ctx, target)
	if err != nil {
		return err
	}
	if !enforceExact {
		if relVersion := releaseVersion(rel); relVersion != "" && current == relVersion {
			logger.Debug("EnsureCodex: already at resolved target", "version", current, "target", target)
			return nil
		}
	}
	asset, err := pickAsset(rel, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	expected := strings.TrimPrefix(asset.Digest, "sha256:")
	if len(expected) != 64 {
		return fmt.Errorf("codex release %s: asset %s has no sha256 digest", rel.TagName, asset.Name)
	}

	tmpDir, err := os.MkdirTemp("", "cdx-codex-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)

	dlPath := filepath.Join(tmpDir, asset.Name)
	if err := downloadFile(ctx, asset.DownloadURL, dlPath); err != nil {
		return err
	}
	gotSHA, err := sha256File(dlPath)
	if err != nil {
		return err
	}
	if !strings.EqualFold(gotSHA, expected) {
		return fmt.Errorf("codex release %s: sha mismatch (want %s, got %s)", rel.TagName, expected, gotSHA)
	}

	dest := resolveCodexDest()
	logger.Debug("EnsureCodex: installing", "version", rel.TagName, "asset", asset.Name, "dest", dest)

	var installErr error
	if strings.HasSuffix(asset.Name, ".tar.gz") || strings.HasSuffix(asset.Name, ".tgz") {
		installErr = installFromTarball(dlPath, dest)
	} else {
		// Raw binary.
		if err := chmodExec(dlPath); err != nil {
			return err
		}
		installErr = installBinary(dlPath, dest)
	}
	if installErr == nil {
		_ = cacheCodex(dest)
	}
	return installErr
}

func releaseVersion(rel Release) string {
	for _, s := range []string{rel.Name, rel.TagName} {
		if v := versionTokenRE.FindString(s); v != "" {
			return v
		}
	}
	return ""
}

// LatestVersion resolves GitHub's current Codex release to a comparable
// semantic version string without downloading the release asset.
func LatestVersion(ctx context.Context) (string, error) {
	rel, err := fetchRelease(ctx, "latest")
	if err != nil {
		return "", err
	}
	v := releaseVersion(rel)
	if v == "" {
		return "", fmt.Errorf("codex latest release has no semantic version")
	}
	return v, nil
}

// resolveCodexDest picks /usr/local/bin/codex when writable (or via sudo),
// else ~/.local/bin/codex. Returns the path; caller may not actually have
// permission, in which case installBinary triggers the sudo fallback.
func resolveCodexDest() string {
	if dir := strings.TrimSpace(os.Getenv("CDX_CODEX_INSTALL_DIR")); dir != "" {
		return filepath.Join(dir, "codex")
	}
	const sys = "/usr/local/bin/codex"
	if dirWritable("/usr/local/bin") {
		return sys
	}
	if _, err := exec.LookPath("sudo"); err == nil {
		return sys
	}
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		_ = os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755)
		return filepath.Join(home, ".local", "bin", "codex")
	}
	return sys
}

func dirWritable(dir string) bool {
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return false
	}
	// Best-effort write probe.
	tmp, err := os.CreateTemp(dir, ".cdx-write-probe-*")
	if err != nil {
		return false
	}
	name := tmp.Name()
	tmp.Close()
	os.Remove(name)
	return true
}

// installFromTarball extracts a Codex tar.gz archive and installs the
// `codex` binary it contains into dest. Exposed for unit-test friendliness.
func installFromTarball(path, dest string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)

	var extracted string
	extractDir, err := os.MkdirTemp("", "cdx-extract-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(extractDir)

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		base := filepath.Base(hdr.Name)
		// Only extract files named codex or codex* (the bash wrapper uses the
		// same heuristic).
		if !strings.HasPrefix(base, "codex") {
			continue
		}
		out := filepath.Join(extractDir, base)
		fp, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(fp, tr); err != nil {
			fp.Close()
			return err
		}
		fp.Close()
		extracted = out
		// First reasonable match wins (matches the bash `head -n1`).
		break
	}
	if extracted == "" {
		return errors.New("installFromTarball: no codex binary in archive")
	}
	if err := chmodExec(extracted); err != nil {
		return err
	}
	return installBinary(extracted, dest)
}

// installBinary copies src to dest, using sudo when the destination directory
// is not writable by the caller.
func installBinary(src, dest string) error {
	dir := filepath.Dir(dest)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		// Try to create the directory. If we can, the user owns it.
		if err := os.MkdirAll(dir, 0o755); err == nil {
			return copyExec(src, dest)
		}
	}
	if dirWritable(dir) {
		return copyExec(src, dest)
	}
	if _, err := exec.LookPath("sudo"); err == nil {
		cmd := exec.Command("sudo", "-n", "install", "-m", "0755", src, dest)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("sudo install: %w: %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	}
	return fmt.Errorf("cannot write %s and no sudo available", dest)
}

func copyExec(src, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dest + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dest)
}

func chmodExec(p string) error { return os.Chmod(p, 0o755) }

func downloadFile(ctx context.Context, url, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "cdx-wrapper-update-check")
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("download %s -> %d", url, resp.StatusCode)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func sha256File(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
