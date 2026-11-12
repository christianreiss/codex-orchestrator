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
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/enginestore"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/installspace"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeentry"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/skillstore"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

const PinnedVersion = "2.5.3"

// SupportedVersion enforces the same native config baseline as the API.
// A prerelease of the baseline itself does not yet satisfy that release.
func SupportedVersion(version string) bool {
	if versionPattern.FindString(version) != version || version == "" {
		return false
	}
	base := strings.SplitN(version, "+", 2)[0]
	numeric := strings.SplitN(base, "-", 2)[0]
	parts, minimum := strings.Split(numeric, "."), strings.Split(PinnedVersion, ".")
	for i := range minimum {
		value, err := strconv.Atoi(parts[i])
		floor, _ := strconv.Atoi(minimum[i])
		if err != nil {
			return false
		}
		if value != floor {
			return value > floor
		}
	}
	return !strings.Contains(base, "-")
}

// CoerceVersionToMinimum heals older server pins while preserving newer pins.
func CoerceVersionToMinimum(version string) string {
	if version == "" || (versionPattern.FindString(version) == version && !SupportedVersion(version)) {
		return PinnedVersion
	}
	return version
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

func StateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".ckx", "state"), nil
}

// Skills is the native on-disk store for fleet Skills (Kimi loads
// ~/.kimi-code/skills/<name>/SKILL.md) with its ownership manifest in ckx state.
func Skills() (skillstore.Store, error) {
	home, err := Home()
	if err != nil {
		return skillstore.Store{}, err
	}
	state, err := StateDir()
	if err != nil {
		return skillstore.Store{}, err
	}
	return skillstore.Store{Root: filepath.Join(home, "skills"), ManifestPath: filepath.Join(state, "skills.json"), Label: "Kimi"}, nil
}

func StoreDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cxx", "engines", "kimi"), nil
}

func FindCLI() (string, error) {
	var candidates []string
	if value := strings.TrimSpace(os.Getenv("CKX_KIMI_BIN")); value != "" {
		candidates = append(candidates, value)
	}
	if state, err := StateDir(); err == nil {
		if raw, err := os.ReadFile(filepath.Join(state, "kimi-bin")); err == nil {
			candidates = append(candidates, strings.TrimSpace(string(raw)))
		}
	}
	if home, err := Home(); err == nil {
		candidates = append(candidates, filepath.Join(home, "bin", "kimi"))
	}
	currentExe, _ := os.Executable()
	if path, err := nativeentry.ResolveVendor("kimi", currentExe); err == nil {
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
	return "", errors.New("Kimi CLI missing; run ckx update")
}

var versionPattern = regexp.MustCompile(`\b([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)\b`)

func ProbeVersion(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Env = NativeEnv(os.Environ())
	out, err := cmd.Output()
	if err != nil {
		return "", errors.New("Kimi version probe failed")
	}
	match := versionPattern.FindStringSubmatch(string(out))
	if len(match) != 2 {
		return "", errors.New("Kimi version probe returned no version")
	}
	return match[1], nil
}

func NativeEnv(env []string) []string {
	return SetEnv(SetEnv(env, "KIMI_CODE_NO_AUTO_UPDATE", "1"), "KIMI_DISABLE_TELEMETRY", "1")
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
		return nil, fmt.Errorf("Kimi package download HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(updateprogress.Reader(ctx, resp.Body, resp.ContentLength), limit+1))
	if err == nil && int64(len(raw)) > limit {
		err = errors.New("Kimi package exceeds download limit")
	}
	return raw, err
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

func prune(pressure bool) error {
	home, err := Home()
	if err != nil {
		return err
	}
	guard, err := TryAcquireMaintenance(home)
	if errors.Is(err, ipc.ErrHeld) {
		return nil
	}
	if err != nil {
		return err
	}
	defer guard.Release()
	root, err := StoreDir()
	if err != nil {
		return err
	}
	_, err = enginestore.PruneEngineResolved(root, "install.lock", nil, FindCLI, pressure)
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
	f, err := os.CreateTemp(filepath.Dir(path), ".ckx-")
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
