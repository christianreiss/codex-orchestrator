package claude

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// defaultClaudeRegistry is the npm registry the npm-less install reads. An
// operator mirror set through npm's own environment variable is honored so a
// host that already points npm elsewhere keeps doing so.
const defaultClaudeRegistry = "https://registry.npmjs.org"

// maxClaudeTarball bounds the platform package download (~100 MiB today).
const maxClaudeTarball = 512 << 20

// musl loaders; a present one selects the -musl platform package, as npm's
// libc-aware optionalDependencies resolution would.
var muslLoaderGlob = "/lib/ld-musl-*.so.1"

// claudePlatformPackage names the @anthropic-ai/claude-code optionalDependency
// carrying the native CLI for this host, or "" when none is published.
func claudePlatformPackage() string {
	var arch string
	switch runtime.GOARCH {
	case "amd64":
		arch = "x64"
	case "arm64":
		arch = "arm64"
	default:
		return ""
	}
	switch runtime.GOOS {
	case "darwin":
		return "@anthropic-ai/claude-code-darwin-" + arch
	case "linux":
		name := "@anthropic-ai/claude-code-linux-" + arch
		if matches, _ := filepath.Glob(muslLoaderGlob); len(matches) > 0 {
			name += "-musl"
		}
		return name
	}
	return ""
}

func claudeRegistry() string {
	for _, key := range []string{"npm_config_registry", "NPM_CONFIG_REGISTRY"} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return strings.TrimRight(v, "/")
		}
	}
	return defaultClaudeRegistry
}

// installNativeClaude stages the pinned native Claude CLI without Node.js or
// npm: the @anthropic-ai/claude-code npm package is only a launcher for this
// per-platform binary, so hosts whose OS cannot ship a new enough Node.js
// (e.g. XCP-ng 8.3 dom0, glibc 2.17) can still run it. The tarball is checked
// against the registry's sha512 integrity before anything is extracted.
func installNativeClaude(ctx context.Context, stage, target string) (string, error) {
	pkg := claudePlatformPackage()
	if pkg == "" {
		return "", fmt.Errorf("no native Claude CLI package for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	registry := claudeRegistry()
	var meta struct {
		Dist struct {
			Tarball   string `json:"tarball"`
			Integrity string `json:"integrity"`
		} `json:"dist"`
	}
	if err := fetchClaudeJSON(ctx, registry+"/"+pkg+"/"+target, &meta); err != nil {
		return "", fmt.Errorf("read %s@%s metadata: %w", pkg, target, err)
	}
	want, ok := strings.CutPrefix(meta.Dist.Integrity, "sha512-")
	if !ok || meta.Dist.Tarball == "" {
		return "", fmt.Errorf("%s@%s metadata has no sha512 tarball integrity", pkg, target)
	}
	digest, err := base64.StdEncoding.DecodeString(want)
	if err != nil || len(digest) != sha512.Size {
		return "", fmt.Errorf("%s@%s metadata has malformed integrity", pkg, target)
	}

	tarball := filepath.Join(stage, "package.tgz")
	if err := downloadClaudeTarball(ctx, meta.Dist.Tarball, tarball, digest); err != nil {
		return "", fmt.Errorf("download %s@%s: %w", pkg, target, err)
	}
	defer os.Remove(tarball)
	dest := filepath.Join(stage, "bin", "claude")
	if err := extractClaudeBinary(tarball, dest); err != nil {
		return "", fmt.Errorf("extract %s@%s: %w", pkg, target, err)
	}
	return dest, nil
}

func fetchClaudeJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}

func downloadClaudeTarball(ctx context.Context, url, dest string, digest []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	h := sha512.New()
	n, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxClaudeTarball+1))
	if err := f.Close(); copyErr == nil {
		copyErr = err
	}
	if copyErr != nil {
		return copyErr
	}
	if n > maxClaudeTarball {
		return errors.New("tarball exceeds size limit")
	}
	if got := h.Sum(nil); string(got) != string(digest) {
		return errors.New("tarball sha512 does not match registry integrity")
	}
	return nil
}

// extractClaudeBinary writes only package/claude; every other entry is ignored,
// so the archive can never place a file outside dest.
func extractClaudeBinary(tarball, dest string) error {
	f, err := os.Open(tarball)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return errors.New("package/claude not found in tarball")
		}
		if err != nil {
			return err
		}
		if hdr.Name != "package/claude" || hdr.Typeflag != tar.TypeReg {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, io.LimitReader(tr, maxClaudeTarball))
		if err := out.Close(); copyErr == nil {
			copyErr = err
		}
		return copyErr
	}
}
