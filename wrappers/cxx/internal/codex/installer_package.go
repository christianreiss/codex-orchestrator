package codex

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/installspace"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/libcselect"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

const standaloneReceipt = ".cxx-standalone-layout"
const maxPackageFiles = 4096
const maxPackageBytes = 2 << 30

type packageMetadata struct {
	LayoutVersion int    `json:"layoutVersion"`
	Version       string `json:"version"`
	Target        string `json:"target"`
	Entrypoint    string `json:"entrypoint"`
	ResourcesDir  string `json:"resourcesDir"`
}
type voiceManifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	BuildCommit   string            `json:"buildCommit"`
	AppTarget     string            `json:"appTarget"`
	VoiceTarget   string            `json:"voiceTarget"`
	AppVersion    string            `json:"appVersion"`
	SHA256        map[string]string `json:"sha256"`
}

func pickPackageAsset(ctx context.Context, rel Release) (Asset, error) {
	triple, err := archTriple(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return Asset{}, err
	}
	if libcselect.Requested(ctx) == libcselect.GNU {
		triple = strings.TrimSuffix(triple, "musl") + "gnu"
	}
	name := "codex-package-" + triple + ".tar.gz"
	for _, a := range rel.Assets {
		if a.Name == name {
			return a, nil
		}
	}
	// Releases without full packages retain the legacy installer. If packages
	// exist, never silently drop resources by selecting a standalone binary.
	for _, a := range rel.Assets {
		if strings.HasPrefix(a.Name, "codex-package-") && strings.HasSuffix(a.Name, ".tar.gz") {
			return Asset{}, fmt.Errorf("%w: no full Codex package %s", libcselect.ErrUnavailable, name)
		}
	}
	return Asset{}, nil
}

func regularFile(p string, executable bool) bool {
	info, err := os.Lstat(p)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0 && (!executable || info.Mode().Perm()&0111 != 0)
}

// Maintenance checks the complete inventory without rehashing hundreds of MB on
// every sync. All hashes are checked before publication. A missing/truncated
// file invalidates same-version convergence and stages a fresh private prefix.
func codexInstallationHealthy(cli string) bool {
	if !regularFile(cli, true) || !regularFile(filepath.Join(filepath.Dir(cli), codeModeHostBinName), true) {
		return false
	}
	if filepath.Base(filepath.Dir(cli)) != "bin" {
		b, err := os.ReadFile(filepath.Join(filepath.Dir(cli), standaloneReceipt))
		return err == nil && string(b) == "v1\n"
	}
	root := filepath.Dir(filepath.Dir(cli))
	var inventory map[string]int64
	if readPackageJSON(filepath.Join(root, ".cxx-package-files.json"), &inventory) != nil || len(inventory) == 0 {
		return false
	}
	for name, size := range inventory {
		if !packagePath(name) {
			return false
		}
		info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil || !info.Mode().IsRegular() || info.Size() != size {
			return false
		}
	}
	return validateCodexPackage(context.Background(), root, "", "", false) == nil
}

func packagePath(name string) bool {
	return name != "" && !strings.Contains(name, "\\") && !strings.Contains(name, ":") && !strings.HasPrefix(name, "/") && path.Clean(name) == name && name != "." && name != ".." && !strings.HasPrefix(name, "../")
}

func extractCodexPackage(ctx context.Context, archive, dest string) error {
	f, err := os.Open(archive)
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
	seen := make(map[string]bool)
	var expanded int64
	for count := 0; ; count++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(h.Name, "/")
		if count >= maxPackageFiles || !packagePath(name) || seen[name] || strings.HasPrefix(path.Base(name), ".cxx-") || path.Base(name) == ".libc-selection.json" {
			return fmt.Errorf("invalid or duplicate package member %q", h.Name)
		}
		seen[name] = true
		out := filepath.Join(dest, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(out, 0755); err != nil {
				return err
			}
		case tar.TypeReg:
			if h.Size < 0 || h.Size > maxPackageBytes-expanded {
				return fmt.Errorf("Codex package exceeds expansion limit")
			}
			expanded += h.Size
			if err := installspace.Check(ctx, "Codex package", installspace.Need{Path: dest, Bytes: uint64(h.Size), Inodes: 1}); err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(out), 0755); err != nil {
				return err
			}
			mode := os.FileMode(0644)
			if h.Mode&0111 != 0 {
				mode = 0755
			}
			file, err := os.OpenFile(out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return err
			}
			_, err = io.CopyN(file, tr, h.Size)
			closeErr := file.Close()
			if err != nil {
				return installspace.WriteError("Codex package", out, err)
			}
			if closeErr != nil {
				return closeErr
			}
		default:
			return fmt.Errorf("unsupported package member type for %q", h.Name)
		}
	}
}

func readPackageJSON(p string, value any) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 1<<20+1))
	if err != nil {
		return err
	}
	if len(b) > 1<<20 {
		return fmt.Errorf("package metadata too large")
	}
	return json.Unmarshal(b, value)
}

func validateCodexPackage(ctx context.Context, dir, version, target string, hashes bool) error {
	bad := func(message string) error { return fmt.Errorf("%w: %s", libcselect.ErrIntegrity, message) }
	var metadata packageMetadata
	if err := readPackageJSON(filepath.Join(dir, "codex-package.json"), &metadata); err != nil {
		return bad("Codex package metadata: " + err.Error())
	}
	if metadata.LayoutVersion != 1 || metadata.Entrypoint != "bin/codex" || metadata.ResourcesDir != "codex-resources" || metadata.Version == "" || (version != "" && metadata.Version != version) || (target != "" && metadata.Target != target) {
		return bad("Codex package identity mismatch")
	}
	for _, p := range []string{"bin/codex", "bin/" + codeModeHostBinName, "bin/codex-exec-server", "codex-path/rg"} {
		if !regularFile(filepath.Join(dir, p), true) {
			return bad("missing executable " + p)
		}
	}
	var manifest voiceManifest
	if err := readPackageJSON(filepath.Join(dir, "codex-resources/voice/manifest.json"), &manifest); err != nil {
		return bad("Voice manifest: " + err.Error())
	}
	voiceTarget := metadata.Target
	if strings.HasSuffix(voiceTarget, "-musl") {
		voiceTarget = strings.TrimSuffix(voiceTarget, "musl") + "gnu"
	}
	if manifest.SchemaVersion != 1 || manifest.AppVersion != metadata.Version || manifest.AppTarget != metadata.Target || manifest.VoiceTarget != voiceTarget || len(manifest.BuildCommit) != 40 || len(manifest.SHA256) == 0 {
		return bad("Voice manifest identity mismatch")
	}
	library := "codex-resources/voice/lib/libgstreamer-1.0.so.0"
	if runtime.GOOS == "darwin" {
		library = "codex-resources/voice/lib/libgstreamer-1.0.0.dylib"
	}
	for _, name := range []string{"bin/codex", "codex-resources/voice/bin/codex-voice-host", "codex-resources/voice/runtime.json", library} {
		if _, ok := manifest.SHA256[name]; !ok {
			return bad("Voice manifest omits " + name)
		}
	}
	for name, expected := range manifest.SHA256 {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !packagePath(name) || (name != "bin/codex" && !strings.HasPrefix(name, "codex-resources/voice/")) {
			return bad("invalid Voice inventory path")
		}
		if b, err := hex.DecodeString(expected); err != nil || len(b) != 32 {
			return bad("invalid Voice inventory digest")
		}
		p := filepath.Join(dir, filepath.FromSlash(name))
		if !regularFile(p, name == "codex-resources/voice/bin/codex-voice-host") {
			return bad("missing Voice file " + name)
		}
		if hashes {
			got, err := sha256File(p)
			if err != nil || !strings.EqualFold(got, expected) {
				return bad("Voice hash mismatch: " + name)
			}
		}
	}
	return nil
}

func installCodexPackage(ctx context.Context, rel Release, asset Asset, dir string, logger *slog.Logger) error {
	expected, err := hex.DecodeString(strings.TrimPrefix(asset.Digest, "sha256:"))
	if err != nil || len(expected) != 32 || !strings.HasPrefix(asset.Digest, "sha256:") {
		return fmt.Errorf("%w: full Codex package has no sha256 digest", libcselect.ErrIntegrity)
	}
	ctx = updateprogress.WithArtifact(ctx, "Codex package with Voice")
	tmp, err := os.MkdirTemp("", "cxx-codex-package-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	archive := filepath.Join(tmp, "package.tar.gz")
	if err := downloadFile(ctx, asset.DownloadURL, archive); err != nil {
		return err
	}
	updateprogress.Emit(ctx, updateprogress.Event{Phase: "verifying"})
	got, err := sha256File(archive)
	if err != nil {
		return err
	}
	if !strings.EqualFold(got, hex.EncodeToString(expected)) {
		return fmt.Errorf("%w: Codex package sha mismatch", libcselect.ErrIntegrity)
	}
	if err := extractCodexPackage(ctx, archive, dir); err != nil {
		return err
	}
	target := strings.TrimSuffix(strings.TrimPrefix(asset.Name, "codex-package-"), ".tar.gz")
	if err := validateCodexPackage(ctx, dir, releaseVersion(rel), target, true); err != nil {
		return err
	}
	// No microphone or network access: validate the loader, exact build identity
	// and native plugins. A pure musl host can still install/use the CLI.
	if runtime.GOOS != "linux" || libcselect.Detect(ctx).GNU {
		var manifest voiceManifest
		if err := readPackageJSON(filepath.Join(dir, "codex-resources/voice/manifest.json"), &manifest); err != nil {
			return err
		}
		out, err := libcselect.Probe(ctx, filepath.Join(dir, "codex-resources/voice/bin/codex-voice-host"), "--build-commit")
		if err != nil {
			return fmt.Errorf("validate Voice host: %w", err)
		}
		if strings.TrimSpace(string(out)) != manifest.BuildCommit {
			return fmt.Errorf("%w: Voice helper build mismatch", libcselect.ErrIntegrity)
		}
		if err := probeVoiceRuntime(ctx, filepath.Join(dir, "codex-resources/voice/bin/codex-voice-host"), manifest.BuildCommit); err != nil {
			return err
		}
	} else {
		logger.Info("Codex Voice requires a glibc runtime; CLI remains available")
	}
	inventory := make(map[string]int64)
	if err := filepath.WalkDir(dir, func(p string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		name, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		inventory[filepath.ToSlash(name)] = info.Size()
		return nil
	}); err != nil {
		return err
	}
	receipt, err := json.Marshal(inventory)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, ".cxx-package-files.json"), receipt, 0600)
}
