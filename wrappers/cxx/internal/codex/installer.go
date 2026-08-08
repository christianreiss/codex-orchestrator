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
	if !enforceExact && current != "" && current != "unknown" && target != "" {
		skip := false
		if current == target {
			logger.Debug("EnsureCodex: already at target", "version", current)
			skip = true
		} else if !semverGT(target, current) {
			logger.Debug("EnsureCodex: skipping downgrade", "current", current, "target", target)
			skip = true
		}
		if skip {
			// codex itself needs no action — the common case, true for the
			// overwhelming majority of already-converged hosts. Still make
			// sure the codex-code-mode-host companion binary is present and
			// version-matched; the cheap marker/stat check runs first so this
			// fast path pays zero extra subprocess/network cost once a host
			// has converged (isManagedByNpm shells out to npm, so it's only
			// worth paying for when the marker/stat check says work is
			// needed).
			if dir := companionInstallDir(); dir != "" && codeModeHostNeedsWork(current, dir) && !isManagedByNpm(ctx) {
				ensureCodeModeHost(ctx, current, nil, dir, logger)
			}
			return nil
		}
	}

	if isManagedByNpm(ctx) {
		return ensureCodexNpm(ctx, target, enforceExact, logger)
	}
	rel, err := ensureCodexGitHub(ctx, target, enforceExact, current, logger)
	if err == nil {
		// codex was just (re)installed — this is the one moment the
		// codex/codex-code-mode-host version handshake can actually drift,
		// so force a refresh regardless of the marker, reusing the already-
		// fetched release instead of a second GitHub API call.
		newVersion := strings.TrimSpace(Version(ctx))
		if dir := companionInstallDir(); dir != "" {
			ensureCodeModeHost(ctx, newVersion, &rel, dir, logger)
		}
	}
	return err
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
	return pickAssetFor(rel, "codex", goos, goarch)
}

// pickAssetFor is pickAsset generalized over the target binary name, so it
// can also select the codex-code-mode-host companion asset from the same
// release. Prefix matching already discriminates the two: "codex-code-mode-
// host-x86_64-..." does not share the "codex-x86_64-..." prefix used for the
// CLI itself, so there is no ambiguity between the two binaries' assets.
func pickAssetFor(rel Release, binName, goos, goarch string) (Asset, error) {
	prefix, err := assetPrefixFor(binName, goos, goarch)
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
	return assetPrefixFor("codex", goos, goarch)
}

// assetPrefixFor returns the release-asset name prefix for binName on
// goos/goarch. binName is "codex" for the CLI itself, or
// "codex-code-mode-host" for its companion — both follow the same
// upstream `<binary>-<arch-triple>` naming convention.
func assetPrefixFor(binName, goos, goarch string) (string, error) {
	triple, err := archTriple(goos, goarch)
	if err != nil {
		return "", err
	}
	return binName + "-" + triple, nil
}

func archTriple(goos, goarch string) (string, error) {
	switch goos + "/" + goarch {
	case "linux/amd64":
		return "x86_64-unknown-linux-musl", nil
	case "linux/arm64":
		return "aarch64-unknown-linux-musl", nil
	case "darwin/arm64":
		return "aarch64-apple-darwin", nil
	case "darwin/amd64":
		return "x86_64-apple-darwin", nil
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

// ensureCodexGitHub installs/updates codex from a GitHub release and returns
// the resolved Release so a caller that also needs to ensure the
// codex-code-mode-host companion binary (version-locked to the same release)
// can reuse it instead of issuing a second GitHub API call.
func ensureCodexGitHub(ctx context.Context, target string, enforceExact bool, current string, logger *slog.Logger) (Release, error) {
	rel, err := fetchRelease(ctx, target)
	if err != nil {
		return Release{}, err
	}
	if !enforceExact {
		if relVersion := releaseVersion(rel); relVersion != "" && current == relVersion {
			logger.Debug("EnsureCodex: already at resolved target", "version", current, "target", target)
			return rel, nil
		}
	}
	asset, err := pickAsset(rel, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return rel, err
	}
	// NOTE: asset.Digest comes from the same GitHub release JSON as the
	// download URL, so this only guards against transport corruption, not a
	// compromised/malicious release (an attacker able to replace the binary
	// could replace the digest field too). Genuine supply-chain protection
	// would require an independently-signed checksum or attestation (e.g.
	// cosign / `gh attestation verify` against a pinned key), which upstream
	// does not currently publish and which is out of scope here.
	expected := strings.TrimPrefix(asset.Digest, "sha256:")
	if len(expected) != 64 {
		return rel, fmt.Errorf("codex release %s: asset %s has no sha256 digest", rel.TagName, asset.Name)
	}

	tmpDir, err := os.MkdirTemp("", "cdx-codex-*")
	if err != nil {
		return rel, err
	}
	defer os.RemoveAll(tmpDir)

	dlPath := filepath.Join(tmpDir, asset.Name)
	if err := downloadFile(ctx, asset.DownloadURL, dlPath); err != nil {
		return rel, err
	}
	gotSHA, err := sha256File(dlPath)
	if err != nil {
		return rel, err
	}
	if !strings.EqualFold(gotSHA, expected) {
		return rel, fmt.Errorf("codex release %s: sha mismatch (want %s, got %s)", rel.TagName, expected, gotSHA)
	}

	dest := resolveCodexDest()
	logger.Debug("EnsureCodex: installing", "version", rel.TagName, "asset", asset.Name, "dest", dest)

	var installErr error
	if strings.HasSuffix(asset.Name, ".tar.gz") || strings.HasSuffix(asset.Name, ".tgz") {
		installErr = installFromTarball(dlPath, dest)
	} else {
		// Raw binary.
		if err := chmodExec(dlPath); err != nil {
			return rel, err
		}
		installErr = installBinary(dlPath, dest)
	}
	if installErr == nil {
		_ = cacheCodex(dest)
	}
	return rel, installErr
}

func releaseVersion(rel Release) string {
	for _, s := range []string{rel.Name, rel.TagName} {
		if v := versionTokenRE.FindString(s); v != "" {
			return v
		}
	}
	return ""
}

// resolveCodexDest picks /usr/local/bin/codex when writable (or via sudo),
// else ~/.local/bin/codex. Returns the path; caller may not actually have
// permission, in which case installBinary triggers the sudo fallback.
func resolveCodexDest() string {
	return resolveInstallDest("codex")
}

// resolveInstallDest picks /usr/local/bin/<binName> when writable (or via
// sudo), else ~/.local/bin/<binName>. Returns the path; caller may not
// actually have permission, in which case installBinary triggers the sudo
// fallback.
func resolveInstallDest(binName string) string {
	if dir := strings.TrimSpace(os.Getenv("CDX_CODEX_INSTALL_DIR")); dir != "" {
		return filepath.Join(dir, binName)
	}
	sys := filepath.Join("/usr/local/bin", binName)
	if dirWritable("/usr/local/bin") {
		return sys
	}
	if _, err := exec.LookPath("sudo"); err == nil {
		return sys
	}
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		_ = os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755)
		return filepath.Join(home, ".local", "bin", binName)
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
	return installFromTarballNamed(path, dest, []string{"codex"}, "codex")
}

// installFromTarballNamed extracts a tar.gz archive and installs the binary
// it contains into dest. exactNames is tried in archive order; the first
// entry whose basename exactly matches any of exactNames wins outright. If
// no exact match is found, the first entry whose basename has the given
// prefix is used as a fallback. An exact match always wins over a prefix
// match so that ancillary files like codex-LICENSE or codex.1 shipped ahead
// of the real binary in archive order can't be installed in its place.
//
// exactNames supports more than one candidate because upstream is not
// consistent about tarball entry naming: codex's own tarball entry is the
// bare binary name ("codex"), but the codex-code-mode-host companion's
// tarball entry is named with the full platform-qualified asset stem (e.g.
// "codex-code-mode-host-x86_64-unknown-linux-musl") — confirmed by
// extracting a real downloaded release asset.
func installFromTarballNamed(path, dest string, exactNames []string, prefix string) error {
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

	exact := make(map[string]struct{}, len(exactNames))
	for _, n := range exactNames {
		exact[n] = struct{}{}
	}

	var extracted string
	var fallback string
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
		_, isExact := exact[base]
		if !isExact && !strings.HasPrefix(base, prefix) {
			continue
		}
		if !isExact && fallback != "" {
			// Already have a prefix-match fallback candidate; keep scanning
			// for an exact entry without extracting more decoys.
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
		if isExact {
			extracted = out
			break
		}
		fallback = out
	}
	if extracted == "" {
		extracted = fallback
	}
	if extracted == "" {
		return fmt.Errorf("installFromTarballNamed: no matching binary in archive (want %v or prefix %q)", exactNames, prefix)
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
	out, err := os.CreateTemp(filepath.Dir(dest), filepath.Base(dest)+".*")
	if err != nil {
		return err
	}
	tmp := out.Name()
	if err := out.Chmod(0o755); err != nil {
		out.Close()
		_ = os.Remove(tmp)
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
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
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

// --- codex-code-mode-host companion -----------------------------------------
//
// `codex` ships a "Code Mode" feature (stable, enabled by default upstream)
// that spawns this companion binary as a subprocess. Upstream publishes it as
// a version-pinned asset on the same GitHub releases as `codex` itself — the
// CLI and host binary share a versioned handshake, so they must be pinned
// together. Without it, `codex` fails closed with a "Code Mode is
// unavailable... host executable was not found" warning on every launch.
//
// The companion has no `--version` flag (confirmed live: only `--listen` and
// `--help`), so its installed version can't be introspected the way
// Version(ctx) introspects codex. A small local marker file tracks which
// codex version it was last installed for instead.

const codeModeHostBinName = "codex-code-mode-host"

// codeModeHostRetryCooldown bounds how often a failed install is retried.
// Unauthenticated GitHub API calls are rate-limited to 60/hr per source IP;
// without a cooldown, ~103 hosts hitting a transient GitHub error could each
// retry on every cron tick and starve codex's own update checks, which share
// the same quota.
const codeModeHostRetryCooldown = 6 * time.Hour

type codeModeHostState struct {
	InstalledFor        string `json:"installed_for"`
	LastAttemptFailedAt string `json:"last_attempt_failed_at,omitempty"`
}

func codeModeHostMarkerPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "codex-orchestrator", "cdx-code-mode-host-state"), nil
}

// readCodeModeHostState returns the zero value on any error (missing file,
// unreadable, malformed) — callers treat that identically to "never
// installed", which is always the safe default.
func readCodeModeHostState() codeModeHostState {
	p, err := codeModeHostMarkerPath()
	if err != nil {
		return codeModeHostState{}
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return codeModeHostState{}
	}
	var s codeModeHostState
	if err := json.Unmarshal(b, &s); err != nil {
		return codeModeHostState{}
	}
	return s
}

func writeCodeModeHostState(s codeModeHostState) error {
	p, err := codeModeHostMarkerPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o644)
}

// codeModeHostNeedsWork reports whether the companion binary in dir needs
// installing or refreshing for codexVersion: missing, zero-byte, or the
// marker's recorded version doesn't match. Returns false during the retry
// cooldown after a recorded failure, even if the binary is still missing.
func codeModeHostNeedsWork(codexVersion, dir string) bool {
	dest := filepath.Join(dir, codeModeHostBinName)
	state := readCodeModeHostState()

	if fi, err := os.Stat(dest); err == nil && fi.Size() > 0 && state.InstalledFor == codexVersion {
		return false
	}
	if state.LastAttemptFailedAt != "" {
		if failedAt, err := time.Parse(time.RFC3339, state.LastAttemptFailedAt); err == nil {
			if time.Since(failedAt) < codeModeHostRetryCooldown {
				return false
			}
		}
	}
	return true
}

// companionInstallDir derives the directory codex-code-mode-host must land
// in: the directory of codex's actual resolved binary (via FindCLI, the
// source of truth for where codex really lives), so the companion is always
// a same-directory sibling regardless of which install strategy codex itself
// used. Falls back to resolveInstallDest("codex")'s directory only when
// FindCLI can't resolve anything (e.g. codex genuinely isn't installed yet).
func companionInstallDir() string {
	if p, err := FindCLI(); err == nil && p != "" {
		if dir := filepath.Dir(p); dir != "" && dir != "." {
			return dir
		}
	}
	return filepath.Dir(resolveInstallDest("codex"))
}

// ensureCodeModeHost installs or refreshes the codex-code-mode-host companion
// binary into dir, version-locked to codexVersion. Pass rel when the caller
// just fetched a Release for codex in this same call, to avoid a redundant
// GitHub API call and guarantee the exact same release is used for both
// binaries; pass nil to fetch fresh (the "codex already current, companion
// missing" case).
//
// Never returns an error: every failure is logged and recorded in the state
// marker (so the cooldown in codeModeHostNeedsWork engages), then swallowed.
// A companion-install problem must never regress codex's own install
// guarantee — both callers of EnsureCodex already treat it as best-effort,
// running post-session so it never blocks an interactive launch.
func ensureCodeModeHost(ctx context.Context, codexVersion string, rel *Release, dir string, logger *slog.Logger) {
	dest := filepath.Join(dir, codeModeHostBinName)

	fail := func(err error) {
		logger.Warn("EnsureCodex: codex-code-mode-host companion install failed (non-fatal)", "error", err)
		state := readCodeModeHostState()
		state.LastAttemptFailedAt = time.Now().UTC().Format(time.RFC3339)
		_ = writeCodeModeHostState(state)
	}

	release := rel
	if release == nil {
		r, err := fetchRelease(ctx, codexVersion)
		if err != nil {
			fail(fmt.Errorf("fetch release: %w", err))
			return
		}
		release = &r
	}

	asset, err := pickAssetFor(*release, codeModeHostBinName, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		fail(fmt.Errorf("pick asset: %w", err))
		return
	}
	expected := strings.TrimPrefix(asset.Digest, "sha256:")
	if len(expected) != 64 {
		fail(fmt.Errorf("%s release %s: asset %s has no sha256 digest", codeModeHostBinName, release.TagName, asset.Name))
		return
	}

	tmpDir, err := os.MkdirTemp("", "cdx-code-mode-host-*")
	if err != nil {
		fail(err)
		return
	}
	defer os.RemoveAll(tmpDir)

	dlPath := filepath.Join(tmpDir, asset.Name)
	if err := downloadFile(ctx, asset.DownloadURL, dlPath); err != nil {
		fail(err)
		return
	}
	gotSHA, err := sha256File(dlPath)
	if err != nil {
		fail(err)
		return
	}
	if !strings.EqualFold(gotSHA, expected) {
		fail(fmt.Errorf("%s release %s: sha mismatch (want %s, got %s)", codeModeHostBinName, release.TagName, expected, gotSHA))
		return
	}

	logger.Debug("EnsureCodex: installing codex-code-mode-host", "version", release.TagName, "asset", asset.Name, "dest", dest)

	var installErr error
	if strings.HasSuffix(asset.Name, ".tar.gz") || strings.HasSuffix(asset.Name, ".tgz") {
		// Tarball entries for this binary are named with the full asset stem
		// (e.g. "codex-code-mode-host-x86_64-unknown-linux-musl"), not the
		// bare binary name — confirmed against a real downloaded release.
		exactNames := []string{codeModeHostBinName, strings.TrimSuffix(strings.TrimSuffix(asset.Name, ".tar.gz"), ".tgz")}
		installErr = installFromTarballNamed(dlPath, dest, exactNames, codeModeHostBinName)
	} else {
		if err := chmodExec(dlPath); err != nil {
			fail(err)
			return
		}
		installErr = installBinary(dlPath, dest)
	}
	if installErr != nil {
		fail(installErr)
		return
	}
	_ = writeCodeModeHostState(codeModeHostState{InstalledFor: codexVersion})
}
