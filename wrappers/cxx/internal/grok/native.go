// Package grok owns the native Grok executable and its private version store.
package grok

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/enginestore"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeentry"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/skillstore"
)

const PinnedVersion = "1.0.46"

func Home() (string, error) {
	if value := strings.TrimSpace(os.Getenv("GROK_HOME")); value != "" {
		return filepath.Abs(value)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".grok"), nil
}

func StateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cgx", "state"), nil
}

// Skills is the native on-disk store for fleet Skills (Grok loads
// ~/.grok/skills/<name>/SKILL.md) with its ownership manifest in cgx state.
func Skills() (skillstore.Store, error) {
	home, err := Home()
	if err != nil {
		return skillstore.Store{}, err
	}
	state, err := StateDir()
	if err != nil {
		return skillstore.Store{}, err
	}
	return skillstore.Store{Root: filepath.Join(home, "skills"), ManifestPath: filepath.Join(state, "skills.json"), Label: "Grok"}, nil
}

func StoreDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cxx", "engines", "grok"), nil
}

func FindCLI() (string, error) {
	var candidates []string
	if value := strings.TrimSpace(os.Getenv("CGX_GROK_BIN")); value != "" {
		candidates = append(candidates, value)
	}
	if state, err := StateDir(); err == nil {
		if raw, err := os.ReadFile(filepath.Join(state, "grok-bin")); err == nil {
			candidates = append(candidates, strings.TrimSpace(string(raw)))
		}
	}
	if home, err := Home(); err == nil {
		candidates = append(candidates, filepath.Join(home, "bin", "grok"))
	}
	currentExe, _ := os.Executable()
	if path, err := nativeentry.ResolveVendor("grok", currentExe); err == nil {
		candidates = append(candidates, path)
	}
	self, _ := os.Executable()
	self, _ = filepath.EvalSymlinks(self)
	for _, path := range candidates {
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil || resolved == self || nativeentry.IsWrapperOrShim(path, currentExe) {
			continue
		}
		st, err := os.Stat(resolved)
		if err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0 {
			return resolved, nil
		}
	}
	return "", errors.New("Grok CLI missing; run cgx update")
}

var versionPattern = regexp.MustCompile(`\b([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)\b`)

func ProbeVersion(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Env = NativeEnv(os.Environ())
	out, err := cmd.Output()
	if err != nil {
		return "", errors.New("Grok version probe failed")
	}
	match := versionPattern.FindStringSubmatch(string(out))
	if len(match) != 2 {
		return "", errors.New("Grok version probe returned no version")
	}
	return match[1], nil
}

func NativeEnv(env []string) []string {
	return SetEnv(env, "GROK_DISABLE_AUTOUPDATER", "1")
}
func SetEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, item := range env {
		if !strings.HasPrefix(item, key+"=") {
			out = append(out, item)
		}
	}
	return append(out, key+"="+value)
}

func PlatformPackage(goos, goarch string) (string, error) {
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[goarch]
	if (goos != "linux" && goos != "darwin") || arch == "" {
		return "", fmt.Errorf("unsupported Grok platform %s/%s", goos, goarch)
	}
	return "@xai-official/grok-" + goos + "-" + arch, nil
}

type packageMetadata struct {
	Version string `json:"version"`
	Dist    struct {
		Tarball   string `json:"tarball"`
		Integrity string `json:"integrity"`
	} `json:"dist"`
}

func download(ctx context.Context, client *http.Client, location string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Grok package download HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err == nil && int64(len(raw)) > limit {
		err = errors.New("Grok package exceeds download limit")
	}
	return raw, err
}

// ExtractBinary verifies the complete npm archive before reading its one allowed member.
func ExtractBinary(archive []byte, integrity string) ([]byte, error) {
	if !strings.HasPrefix(integrity, "sha512-") {
		return nil, errors.New("Grok package requires SHA-512 integrity")
	}
	want, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(integrity, "sha512-"))
	if err != nil || len(want) != sha512.Size {
		return nil, errors.New("invalid Grok package integrity")
	}
	sum := sha512.Sum512(archive)
	if !bytes.Equal(sum[:], want) {
		return nil, errors.New("Grok package integrity mismatch")
	}
	z, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	defer z.Close()
	t := tar.NewReader(z)
	var binary []byte
	for {
		header, err := t.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if header.Name != "package/bin/grok.br" {
			continue
		}
		if binary != nil || header.Typeflag != tar.TypeReg {
			return nil, errors.New("invalid Grok binary archive member")
		}
		binary, err = io.ReadAll(io.LimitReader(brotli.NewReader(t), (512<<20)+1))
		if err != nil {
			return nil, err
		}
		if len(binary) == 0 || len(binary) > 512<<20 {
			return nil, errors.New("invalid Grok binary size")
		}
	}
	if binary == nil {
		return nil, errors.New("Grok package contains no package/bin/grok.br")
	}
	return binary, nil
}

func Install(ctx context.Context, version string) (string, error) {
	return installWithClient(ctx, version, &http.Client{Timeout: 3 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many Grok registry redirects")
		}
		if req.URL.Scheme != "https" || req.URL.Host != "registry.npmjs.org" {
			return errors.New("untrusted Grok registry redirect")
		}
		return nil
	}})
}

func installWithClient(ctx context.Context, version string, client *http.Client) (string, error) {
	if version == "" {
		version = PinnedVersion
	}
	if !versionPattern.MatchString(version) || versionPattern.FindString(version) != version {
		return "", errors.New("invalid Grok version")
	}
	root, err := StoreDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(root, "install.lock"))
	if err != nil {
		return "", err
	}
	defer lock.Release()
	pkg, err := PlatformPackage(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	raw, err := download(ctx, client, "https://registry.npmjs.org/"+url.PathEscape(pkg)+"/"+url.PathEscape(version), 1<<20)
	if err != nil {
		return "", err
	}
	var meta packageMetadata
	if err := json.Unmarshal(raw, &meta); err != nil {
		return "", err
	}
	if meta.Version != version {
		return "", errors.New("Grok registry version mismatch")
	}
	u, err := url.Parse(meta.Dist.Tarball)
	if err != nil || u.Scheme != "https" || u.Host != "registry.npmjs.org" {
		return "", errors.New("untrusted Grok tarball origin")
	}
	archive, err := download(ctx, client, u.String(), 300<<20)
	if err != nil {
		return "", err
	}
	binary, err := ExtractBinary(archive, meta.Dist.Integrity)
	if err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(root, version+"-")
	if err != nil {
		return "", err
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(stage)
		}
	}()
	path := filepath.Join(stage, "grok")
	if err := os.WriteFile(path, binary, 0o700); err != nil {
		return "", err
	}
	got, err := ProbeVersion(ctx, path)
	if err != nil || got != version {
		return "", errors.New("staged Grok binary failed version verification")
	}
	state, err := StateDir()
	if err != nil {
		return "", err
	}
	if err := AtomicWrite(filepath.Join(state, "grok-bin"), []byte(path+"\n"), 0o600); err != nil {
		return "", err
	}
	keep = true
	return path, nil
}

func Prune() error {
	root, err := StoreDir()
	if err != nil {
		return err
	}
	path, err := FindCLI()
	if err != nil {
		return err
	}
	_, err = enginestore.PruneEngine(root, path, "install.lock", nil)
	return err
}

func RemoveInstalledCopies() error {
	root, err := StoreDir()
	if err != nil {
		return err
	}
	// The server has confirmed this engine's removal. Busy prefixes remain
	// protected by the same process checks as normal version retention.
	_, err = enginestore.Prune(root, ".uninstalled", "install.lock", nil)
	return err
}

func AtomicWrite(path string, raw []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".cgx-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
