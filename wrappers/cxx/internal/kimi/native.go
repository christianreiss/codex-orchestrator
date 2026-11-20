// Package kimi owns the native Kimi executable and its private version store.
package kimi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/installspace"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeengine"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/skillstore"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

const PinnedVersion = "2.5.3"

// nativeStore is the Kimi native CLI store; its on-disk names are pinned by tests.
var nativeStore = &nativeengine.Store{Label: "Kimi", Binary: "kimi", Persona: "ckx", BinEnv: "CKX_KIMI_BIN", PinnedVersion: PinnedVersion, Home: Home, NativeEnv: NativeEnv}

// SupportedVersion enforces the same native config baseline as the API.
// A prerelease of the baseline itself does not yet satisfy that release.
func SupportedVersion(version string) bool { return nativeStore.SupportedVersion(version) }

// CoerceVersionToMinimum heals older server pins while preserving newer pins.
func CoerceVersionToMinimum(version string) string {
	return nativeStore.CoerceVersionToMinimum(version)
}

func Home() (string, error) {
	if value := strings.TrimSpace(os.Getenv("KIMI_CODE_HOME")); value != "" {
		return filepath.Abs(value)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".kimi-code"), nil
}

func StateDir() (string, error) { return nativeStore.StateDir() }

// Skills is the native on-disk store for fleet Skills (Kimi loads
// ~/.kimi-code/skills/<name>/SKILL.md) with its ownership manifest in ckx state.
func Skills() (skillstore.Store, error) { return nativeStore.Skills() }

func StoreDir() (string, error) { return nativeStore.Dir() }

func FindCLI() (string, error) { return nativeStore.FindCLI() }

var versionPattern = nativeengine.VersionPattern

func ProbeVersion(ctx context.Context, path string) (string, error) {
	return nativeStore.ProbeVersion(ctx, path)
}

func NativeEnv(env []string) []string {
	return SetEnv(SetEnv(env, "KIMI_CODE_NO_AUTO_UPDATE", "1"), "KIMI_DISABLE_TELEMETRY", "1")
}
func SetEnv(env []string, key, value string) []string { return nativeengine.SetEnv(env, key, value) }

func PlatformPackage(goos, goarch string) (string, error) {
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[goarch]
	if (goos != "linux" && goos != "darwin") || arch == "" {
		return "", fmt.Errorf("unsupported Kimi platform %s/%s", goos, goarch)
	}
	return goos + "-" + arch, nil
}

type binaryManifest struct {
	Platforms map[string]struct {
		Filename string `json:"filename"`
		Checksum string `json:"checksum"`
	} `json:"platforms"`
}

func download(ctx context.Context, client *http.Client, location string, limit int64) ([]byte, error) {
	return nativeStore.Download(ctx, client, location, limit)
}

// VerifyBinary checks the manifest's SHA-256 before the executable is published.
func VerifyBinary(binary []byte, checksum string) error {
	want, err := hex.DecodeString(checksum)
	if err != nil || len(want) != sha256.Size {
		return errors.New("invalid Kimi SHA-256 checksum")
	}
	sum := sha256.Sum256(binary)
	if !bytes.Equal(sum[:], want) {
		return errors.New("Kimi binary checksum mismatch")
	}
	if len(binary) == 0 {
		return errors.New("empty Kimi binary")
	}
	return nil
}

func Install(ctx context.Context, version string) (string, error) {
	return installWithClient(ctx, version, &http.Client{Timeout: 3 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many Kimi registry redirects")
		}
		if req.URL.Scheme != "https" || (req.URL.Host != "code.kimi.com" && req.URL.Host != "cdn.kimi.com") {
			return errors.New("untrusted Kimi registry redirect")
		}
		return nil
	}})
}

func installWithClient(ctx context.Context, version string, client *http.Client) (result string, retErr error) {
	version = CoerceVersionToMinimum(version)
	if !versionPattern.MatchString(version) || versionPattern.FindString(version) != version {
		return "", errors.New("invalid Kimi version")
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
	defer func() { retErr = installspace.WriteError("Kimi", root, retErr) }()
	// Cleanup runs before taking the engine installer lock.
	if err := installspace.Ensure(ctx, "Kimi", func() error { return prune(true) }, installspace.Need{Path: root, Bytes: installspace.Native, Inodes: 128}); err != nil {
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
	base := "https://code.kimi.com/kimi-code/binaries/" + version + "/"
	raw, err := download(updateprogress.WithArtifact(ctx, "metadata"), client, base+"manifest.json", 1<<20)
	if err != nil {
		return "", err
	}
	var meta binaryManifest
	if err := json.Unmarshal(raw, &meta); err != nil {
		return "", err
	}
	asset, ok := meta.Platforms[pkg]
	if !ok || asset.Filename == "" || filepath.Base(asset.Filename) != asset.Filename || strings.ContainsAny(asset.Filename, "\\?#") {
		return "", errors.New("invalid Kimi manifest platform")
	}
	if err := installspace.Check(ctx, "Kimi", installspace.Need{Path: root, Bytes: installspace.Native, Inodes: 128}); err != nil {
		return "", err
	}
	binary, err := download(updateprogress.WithArtifact(ctx, "binary"), client, base+asset.Filename, 512<<20)
	if err != nil {
		return "", err
	}
	updateprogress.Emit(ctx, updateprogress.Event{Phase: "verifying"})
	if err := VerifyBinary(binary, asset.Checksum); err != nil {
		return "", err
	}
	if err := installspace.Check(ctx, "Kimi", installspace.Need{Path: root, Bytes: uint64(len(binary)), Inodes: 128}); err != nil {
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
	path := filepath.Join(stage, "kimi")
	if err := os.WriteFile(path, binary, 0o700); err != nil {
		return "", err
	}
	got, err := ProbeVersion(ctx, path)
	if err != nil || got != version {
		return "", errors.New("staged Kimi binary failed version verification")
	}
	finalDir := filepath.Join(root, version)
	finalPath := filepath.Join(finalDir, "kimi")
	existing, readErr := os.ReadFile(finalPath)
	if got, err := ProbeVersion(ctx, finalPath); readErr == nil && VerifyBinary(existing, asset.Checksum) == nil && err == nil && got == version {
		_ = os.RemoveAll(stage)
	} else if _, err := os.Stat(finalDir); err == nil {
		return "", errors.New("existing Kimi version directory failed verification")
	} else if !os.IsNotExist(err) {
		return "", err
	} else if err := os.Rename(stage, finalDir); err != nil {
		return "", err
	}
	path = finalPath
	state, err := StateDir()
	if err != nil {
		return "", err
	}
	if err := AtomicWrite(filepath.Join(state, "kimi-bin"), []byte(path+"\n"), 0o600); err != nil {
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
