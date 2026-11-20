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
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/installspace"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/libcselect"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/enginestore"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeengine"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/skillstore"
)

const PinnedVersion = "1.0.50"

// nativeStore is the Grok native CLI store; its on-disk names are pinned by tests.
var nativeStore = &nativeengine.Store{Label: "Grok", Binary: "grok", Persona: "cgx", BinEnv: "CGX_GROK_BIN", PinnedVersion: PinnedVersion, Home: Home, NativeEnv: NativeEnv}

// SupportedVersion enforces the same native config baseline as the API.
// A prerelease of the baseline itself does not yet satisfy that release.
func SupportedVersion(version string) bool { return nativeStore.SupportedVersion(version) }

// CoerceVersionToMinimum heals older server pins while preserving newer pins.
func CoerceVersionToMinimum(version string) string {
	return nativeStore.CoerceVersionToMinimum(version)
}

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

func StateDir() (string, error) { return nativeStore.StateDir() }

// Skills is the native on-disk store for fleet Skills (Grok loads
// ~/.grok/skills/<name>/SKILL.md) with its ownership manifest in cgx state.
func Skills() (skillstore.Store, error) { return nativeStore.Skills() }

func StoreDir() (string, error) { return nativeStore.Dir() }

func FindCLI() (string, error) { return nativeStore.FindCLI() }

var versionPattern = nativeengine.VersionPattern

func ProbeVersion(ctx context.Context, path string) (string, error) {
	return nativeStore.ProbeVersion(ctx, path)
}

func NativeEnv(env []string) []string {
	return SetEnv(env, "GROK_DISABLE_AUTOUPDATER", "1")
}
func SetEnv(env []string, key, value string) []string { return nativeengine.SetEnv(env, key, value) }

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
	return nativeStore.Download(ctx, client, location, limit)
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
	return reconcileInstall(ctx, version, &http.Client{Timeout: 3 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many Grok registry redirects")
		}
		if req.URL.Scheme != "https" || req.URL.Host != "registry.npmjs.org" {
			return errors.New("untrusted Grok registry redirect")
		}
		return nil
	}})
}

func reconcileInstall(ctx context.Context, version string, client *http.Client) (string, error) {
	if runtime.GOOS != "linux" {
		return installWithClient(ctx, version, client)
	}
	if strings.TrimSpace(os.Getenv("CGX_GROK_BIN")) != "" {
		return "", errors.New("CGX_GROK_BIN selects an operator-managed Grok CLI")
	}
	version = CoerceVersionToMinimum(version)
	root, err := StoreDir()
	if err != nil {
		return "", err
	}
	current := func() (string, string) { p, _ := FindCLI(); v, _ := ProbeVersion(ctx, p); return p, v }
	err = libcselect.Run(ctx, root, version, current, func(attempt context.Context) error { _, e := installWithClient(attempt, version, client); return e }, nil)
	if err != nil {
		return "", err
	}
	p, _ := FindCLI()
	return p, nil
}

// Only package names actually declared by xAI's pinned manifest are eligible.
// The current unsuffixed Linux package is the vendor's musl distribution.
func glibcPackage(ctx context.Context, client *http.Client, version, base string) (string, error) {
	raw, err := download(ctx, client, "https://registry.npmjs.org/@xai-official%2Fgrok/"+url.PathEscape(version), 1<<20)
	if err != nil {
		return "", err
	}
	var manifest struct {
		OptionalDependencies map[string]string `json:"optionalDependencies"`
	}
	if err = json.Unmarshal(raw, &manifest); err != nil {
		return "", err
	}
	for _, name := range []string{base + "-gnu", base + "-glibc"} {
		if _, ok := manifest.OptionalDependencies[name]; ok {
			return name, nil
		}
	}
	return "", fmt.Errorf("%w: xAI manifest has no glibc platform package", libcselect.ErrUnavailable)
}

func installWithClient(ctx context.Context, version string, client *http.Client) (result string, retErr error) {
	version = CoerceVersionToMinimum(version)
	if !versionPattern.MatchString(version) || versionPattern.FindString(version) != version {
		return "", errors.New("invalid Grok version")
	}
	root, err := StoreDir()
	if err != nil {
		return "", err
	}
	ctx, releaseSpace, err := installspace.Lock(ctx)
	if err != nil {
		return "", err
	}
	defer releaseSpace()
	defer func() { retErr = installspace.WriteError("Grok", root, retErr) }()
	// Cleanup runs before taking the engine installer lock.
	if err := installspace.Ensure(ctx, "Grok", func() error { return prune(true) }, installspace.Need{Path: root, Bytes: installspace.Native, Inodes: 128}); err != nil {
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
	if libcselect.Requested(ctx) == libcselect.GNU {
		pkg, err = glibcPackage(ctx, client, version, pkg)
		if err != nil {
			return "", err
		}
	}
	raw, err := download(updateprogress.WithArtifact(ctx, "metadata"), client, "https://registry.npmjs.org/"+url.PathEscape(pkg)+"/"+url.PathEscape(version), 1<<20)
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
	if err := installspace.Check(ctx, "Grok", installspace.Need{Path: root, Bytes: installspace.Native, Inodes: 128}); err != nil {
		return "", err
	}
	archive, err := download(updateprogress.WithArtifact(ctx, "package"), client, u.String(), 300<<20)
	if err != nil {
		return "", err
	}
	updateprogress.Emit(ctx, updateprogress.Event{Phase: "verifying"})
	binary, err := ExtractBinary(archive, meta.Dist.Integrity)
	if err != nil {
		return "", err
	}
	if err := installspace.Check(ctx, "Grok", installspace.Need{Path: root, Bytes: uint64(len(binary)), Inodes: 128}); err != nil {
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
	if _, err := libcselect.Probe(ctx, path, "--version"); err != nil {
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
	if err := libcselect.Publication(ctx, path, pkg+"@"+version+":"+meta.Dist.Integrity); err != nil {
		return "", err
	}
	if err := enginestore.InvalidatePressureAdmission(root); err != nil {
		return "", err
	}
	if err := AtomicWrite(filepath.Join(state, "grok-bin"), []byte(path+"\n"), 0o600); err != nil {
		return "", err
	}
	keep = true
	return path, nil
}

func Prune() error { return prune(false) }

func prune(pressure bool) error { return nativeStore.Prune(pressure) }

func RemoveInstalledCopies() error { return nativeStore.RemoveInstalledCopies() }

func AtomicWrite(path string, raw []byte, mode os.FileMode) error {
	return nativeStore.AtomicWrite(path, raw, mode)
}
