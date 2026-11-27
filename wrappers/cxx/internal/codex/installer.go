// Package codex includes installer.go, the GitHub release helpers that the
// background maintenance installer (installer_background.go) uses to fetch,
// verify and install the upstream `codex` CLI and its companion binary.
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
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/installspace"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/libcselect"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
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

// pickAssetFor returns the release asset of binName for the given platform:
//
//	linux/amd64  → <binName>-x86_64-unknown-linux-musl*  (prefer .tar.gz)
//	linux/arm64  → <binName>-aarch64-unknown-linux-musl*
//	darwin/arm64 → <binName>-aarch64-apple-darwin*
//	darwin/amd64 → <binName>-x86_64-apple-darwin*
//
// It selects the codex CLI and the codex-code-mode-host companion asset from
// the same release. Prefix matching already discriminates the two: "codex-code-mode-
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
		if goos == "windows" && !strings.HasSuffix(a.Name, ".tar.gz") && a.Name != prefix+".exe" {
			// Windows releases also publish .exe.zip/.exe.zst; only the raw
			// executable can be installed without unpacking.
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
	// Windows assets are named codex-<triple>.exe (+ .exe.tar.gz) and
	// codex-package-<triple>.tar.gz. The installer can resolve them; Windows is
	// not a supported platform yet.
	case "windows/amd64":
		return "x86_64-pc-windows-msvc", nil
	case "windows/arm64":
		return "aarch64-pc-windows-msvc", nil
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

// installVerifiedReleaseAsset shares the verified release pipeline between
// explicit installs and unpublished background destinations.
func installVerifiedReleaseAsset(ctx context.Context, rel Release, asset Asset, name, dest string, logger *slog.Logger) error {
	label := "CLI"
	if name == codeModeHostBinName {
		label = "companion"
	}
	ctx = updateprogress.WithArtifact(ctx, label)
	if filepath.Base(asset.Name) != asset.Name {
		return fmt.Errorf("invalid release asset name %q", asset.Name)
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
		return fmt.Errorf("%s release %s: asset %s has no sha256 digest", name, rel.TagName, asset.Name)
	}

	ctx, releaseSpace, err := installspace.Lock(ctx)
	if err != nil {
		return err
	}
	defer releaseSpace()
	temporary, expanded := releaseAssetSpace(asset)
	if err := installspace.Ensure(ctx, name, nil,
		installspace.Need{Path: os.TempDir(), Bytes: temporary, Inodes: 128},
		installspace.Need{Path: filepath.Dir(dest), Bytes: expanded, Inodes: 128}); err != nil {
		return err
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
	updateprogress.Emit(ctx, updateprogress.Event{Phase: "verifying"})
	gotSHA, err := sha256File(dlPath)
	if err != nil {
		return err
	}
	if !strings.EqualFold(gotSHA, expected) {
		return fmt.Errorf("%s release %s: sha mismatch (want %s, got %s)", name, rel.TagName, expected, gotSHA)
	}

	logger.Debug("EnsureCodex: installing", "version", rel.TagName, "asset", asset.Name, "dest", dest)
	updateprogress.Emit(ctx, updateprogress.Event{Phase: "installing"})

	var installErr error
	if strings.HasSuffix(asset.Name, ".tar.gz") || strings.HasSuffix(asset.Name, ".tgz") {
		stem := strings.TrimSuffix(strings.TrimSuffix(asset.Name, ".tar.gz"), ".tgz")
		installErr = installFromTarballNamedContext(ctx, dlPath, dest, []string{name, stem}, name)
	} else {
		// Raw binary.
		if err := chmodExec(dlPath); err != nil {
			return err
		}
		installErr = installBinaryContext(ctx, dlPath, dest)
	}
	return installErr
}

// Raw releases have a known final size; compressed releases need room for both
// the archive and an expanded binary until the verified copy is installed.
func releaseAssetSpace(asset Asset) (temporary, expanded uint64) {
	size := installspace.Size(asset.Size, installspace.Wrapper)
	if strings.HasSuffix(asset.Name, ".tar.gz") || strings.HasSuffix(asset.Name, ".tgz") {
		return size + installspace.Native, installspace.Native
	}
	return size, size
}

func releaseVersion(rel Release) string {
	for _, s := range []string{rel.Name, rel.TagName} {
		if v := versionTokenRE.FindString(s); v != "" {
			return v
		}
	}
	return ""
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

// installFromTarballNamedContext extracts a tar.gz archive and installs the binary
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
func installFromTarballNamedContext(ctx context.Context, path, dest string, exactNames []string, prefix string) error {
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
		if hdr.Size < 0 {
			return fmt.Errorf("invalid tar member size")
		}
		if err := installspace.Check(ctx, prefix,
			installspace.Need{Path: extractDir, Bytes: uint64(hdr.Size), Inodes: 1},
			installspace.Need{Path: filepath.Dir(dest), Bytes: uint64(hdr.Size), Inodes: 1}); err != nil {
			return err
		}
		out := filepath.Join(extractDir, base)
		fp, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(fp, tr); err != nil {
			fp.Close()
			return installspace.WriteError(prefix, out, err)
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
	return installBinaryContext(ctx, extracted, dest)
}

// installBinaryContext copies src to dest, using sudo when the destination
// directory is not writable by the caller.
func installBinaryContext(ctx context.Context, src, dest string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if err := installspace.Check(ctx, "Codex binary copy", installspace.Need{Path: filepath.Dir(dest), Bytes: uint64(info.Size()), Inodes: 1}); err != nil {
		return err
	}
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
	if err := installspace.Check(ctx, "Codex download", installspace.Need{Path: filepath.Dir(dest), Bytes: installspace.Size(resp.ContentLength, installspace.Wrapper), Inodes: 1}); err != nil {
		return err
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, updateprogress.Reader(ctx, resp.Body, resp.ContentLength)); err != nil {
		f.Close()
		return installspace.WriteError("Codex download", dest, err)
	}
	return installspace.WriteError("Codex download", dest, f.Close())
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
// Version(ctx) introspects codex. The background installer therefore
// installs it from the same release whenever it installs codex.

const codeModeHostBinName = "codex-code-mode-host"

// pickAssetForLibc retains the upstream platform mapping outside reconciliation.
func pickAssetForLibc(ctx context.Context, rel Release, name string) (Asset, error) {
	variant := libcselect.Requested(ctx)
	if variant == "" || variant == libcselect.Musl {
		return pickAssetFor(rel, name, runtime.GOOS, runtime.GOARCH)
	}
	triple, err := archTriple(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return Asset{}, err
	}
	prefix := name + "-" + strings.TrimSuffix(triple, "musl") + "gnu"
	var raw Asset
	for _, a := range rel.Assets {
		if a.Name == prefix+".tar.gz" {
			return a, nil
		}
		if a.Name == prefix {
			raw = a
		}
	}
	if raw.Name != "" {
		return raw, nil
	}
	return Asset{}, fmt.Errorf("%w: no glibc %s for %s", libcselect.ErrUnavailable, name, rel.TagName)
}
