package codex

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/libcselect"
)

func packageFixture(t *testing.T, mutate func(map[string]string)) []byte {
	t.Helper()
	target, _ := archTriple(runtime.GOOS, runtime.GOARCH)
	voiceTarget := strings.TrimSuffix(target, "musl")
	if strings.HasSuffix(target, "musl") {
		voiceTarget += "gnu"
	}
	commit := strings.Repeat("a", 40)
	library := "codex-resources/voice/lib/libgstreamer-1.0.so.0"
	if runtime.GOOS == "darwin" {
		library = "codex-resources/voice/lib/libgstreamer-1.0.0.dylib"
	}
	files := map[string]string{
		"bin/codex":                                  "#!/bin/sh\necho 'codex 9.9.9'\n",
		"bin/codex-code-mode-host":                   "#!/bin/sh\necho companion\n",
		"bin/codex-exec-server":                      "#!/bin/sh\nexit 0\n",
		"codex-path/rg":                              "#!/bin/sh\nexit 0\n",
		"codex-resources/voice/bin/codex-voice-host": fakeVoiceHelper(commit),
		"codex-resources/voice/runtime.json":         "{}\n",
		library:                                      "runtime\n",
	}
	meta, _ := json.Marshal(packageMetadata{LayoutVersion: 1, Version: "9.9.9", Target: target, Entrypoint: "bin/codex", ResourcesDir: "codex-resources"})
	files["codex-package.json"] = string(meta)
	m := voiceManifest{SchemaVersion: 1, BuildCommit: commit, AppTarget: target, VoiceTarget: voiceTarget, AppVersion: "9.9.9", SHA256: make(map[string]string)}
	for name, body := range files {
		if name == "bin/codex" || strings.HasPrefix(name, "codex-resources/voice/") {
			sum := sha256.Sum256([]byte(body))
			m.SHA256[name] = hex.EncodeToString(sum[:])
		}
	}
	manifest, _ := json.Marshal(m)
	files["codex-resources/voice/manifest.json"] = string(manifest)
	if mutate != nil {
		mutate(files)
	}
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0755, Typeflag: tar.TypeReg, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestFullPackageRepairsSameVersionAndPreservesOldPrefix(t *testing.T) {
	var archive []byte
	_, _ = backgroundFixture(t, backgroundReleaseFixture{fullPackage: func() []byte { return archive }})
	ctx := context.Background()
	if err := EnsureCodexBackground(ctx, "9.9.9", true, nil); err != nil {
		t.Fatal(err)
	}
	old, _ := FindCLI()
	// Model an installation made by a previous wrapper, before package receipts.
	if err := os.Remove(filepath.Join(filepath.Dir(old), standaloneReceipt)); err != nil {
		t.Fatal(err)
	}
	archive = packageFixture(t, nil)
	if err := EnsureCodexBackground(ctx, "9.9.9", true, nil); err != nil {
		t.Fatal(err)
	}
	cli, _ := FindCLI()
	if cli == old || filepath.Base(filepath.Dir(cli)) != "bin" || !codexInstallationHealthy(cli) {
		t.Fatalf("full package not selected: %s", cli)
	}
	if _, err := os.Stat(old); err != nil {
		t.Fatal("old running prefix lost", err)
	}
	if err := EnsureCodexBackground(ctx, "9.9.9", true, nil); err != nil {
		t.Fatal(err)
	}
	same, _ := FindCLI()
	if same != cli {
		t.Fatal("converged package reinstalled")
	}
	// A nonempty truncated library is still damage and must trigger repair.
	lib := filepath.Join(filepath.Dir(filepath.Dir(cli)), "codex-resources/voice/runtime.json")
	if err := os.WriteFile(lib, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureCodexBackground(ctx, "9.9.9", true, nil); err != nil {
		t.Fatal(err)
	}
	repaired, _ := FindCLI()
	if repaired == cli || !codexInstallationHealthy(repaired) {
		t.Fatal("same-version damaged resource not repaired")
	}
	removed, err := PruneEngineStore(backgroundLogger())
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) == 0 || !codexInstallationHealthy(repaired) {
		t.Fatal("prune failed to preserve nested selected package")
	}
}

func TestFullPackageFailureKeepsSelectedCLI(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(map[string]string)
	}{
		{"missing helper", func(f map[string]string) { delete(f, "codex-resources/voice/bin/codex-voice-host") }},
		{"corrupt runtime", func(f map[string]string) { f["codex-resources/voice/runtime.json"] = "broken" }},
		{"wrong metadata", func(f map[string]string) { f["codex-package.json"] = `{"version":"9.9.8"}` }},
		{"helper cannot load", func(f map[string]string) {
			p := "codex-resources/voice/bin/codex-voice-host"
			f[p] = "#!/bin/sh\nexit 42\n"
			var m voiceManifest
			_ = json.Unmarshal([]byte(f["codex-resources/voice/manifest.json"]), &m)
			sum := sha256.Sum256([]byte(f[p]))
			m.SHA256[p] = hex.EncodeToString(sum[:])
			b, _ := json.Marshal(m)
			f["codex-resources/voice/manifest.json"] = string(b)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			archive := packageFixture(t, tc.mutate)
			home, before := backgroundFixture(t, backgroundReleaseFixture{fullPackage: func() []byte { return archive }})
			ctx := libcselect.WithHost(context.Background(), libcselect.Host{GNU: true, Fingerprint: "test"})
			if err := EnsureCodexBackground(ctx, "9.9.9", true, nil); err == nil {
				t.Fatal("invalid package published")
			}
			after, _ := FindCLI()
			if after != before {
				t.Fatal("failed package replaced selection")
			}
			entries, _ := os.ReadDir(filepath.Join(home, ".cxx/engines/codex"))
			for _, e := range entries {
				if e.IsDir() {
					t.Fatal("failed stage retained", e.Name())
				}
			}
		})
	}
}

func TestPackageExtractionRejectsUnsafeMembers(t *testing.T) {
	for _, tc := range []struct {
		name string
		kind byte
		link string
	}{
		{"../escape", tar.TypeReg, ""}, {"/absolute", tar.TypeReg, ""}, {"a/../escape", tar.TypeReg, ""}, {"symlink", tar.TypeSymlink, "/tmp"}, {"hardlink", tar.TypeLink, "../escape"}, {"fifo", tar.TypeFifo, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			gz := gzip.NewWriter(&out)
			tw := tar.NewWriter(gz)
			_ = tw.WriteHeader(&tar.Header{Name: tc.name, Mode: 0755, Typeflag: tc.kind, Linkname: tc.link})
			_ = tw.Close()
			_ = gz.Close()
			archive := filepath.Join(t.TempDir(), "package.tgz")
			_ = os.WriteFile(archive, out.Bytes(), 0600)
			if err := extractCodexPackage(context.Background(), archive, t.TempDir()); err == nil {
				t.Fatal("unsafe member accepted")
			}
		})
	}
}

// Optional real-release check: never contacts providers, audio devices or auth.
func TestOfficialCodexPackage(t *testing.T) {
	archive := os.Getenv("CXX_TEST_CODEX_PACKAGE")
	if archive == "" {
		t.Skip("set CXX_TEST_CODEX_PACKAGE to a verified official archive")
	}
	dir := t.TempDir()
	if err := extractCodexPackage(context.Background(), archive, dir); err != nil {
		t.Fatal(err)
	}
	target, _ := archTriple(runtime.GOOS, runtime.GOARCH)
	if err := validateCodexPackage(context.Background(), dir, "0.169.0", target, true); err != nil {
		t.Fatal(err)
	}
	var m voiceManifest
	if err := readPackageJSON(filepath.Join(dir, "codex-resources/voice/manifest.json"), &m); err != nil {
		t.Fatal(err)
	}
	out, err := libcselect.Probe(context.Background(), filepath.Join(dir, "codex-resources/voice/bin/codex-voice-host"), "--build-commit")
	if err != nil || strings.TrimSpace(string(out)) != m.BuildCommit {
		t.Fatalf("real Voice host: %q %v", out, err)
	}
	if err := probeVoiceRuntime(context.Background(), filepath.Join(dir, "codex-resources/voice/bin/codex-voice-host"), m.BuildCommit); err != nil {
		t.Fatal(err)
	}
}

func fakeVoiceHelper(commit string) string {
	frames := ""
	for _, response := range []string{"ready", "runtimeReady", "closed"} {
		body := `{"type":"` + response + `"}`
		frames += fmt.Sprintf(`\000\000\000\%03o`, len(body)) + body
	}
	return "#!/bin/sh\nif [ \"$1\" = --build-commit ]; then echo " + commit + "; exit; fi\nprintf '" + frames + "'\n/bin/cat >/dev/null\n"
}

func TestPackageSelectionDoesNotStripResourcesOnMissingPlatform(t *testing.T) {
	rel := Release{Assets: []Asset{{Name: "codex-package-other-platform.tar.gz"}, {Name: "codex-x86_64-unknown-linux-musl.tar.gz"}}}
	if _, err := pickPackageAsset(context.Background(), rel); err == nil {
		t.Fatal("missing package fell back to standalone")
	}
	rel.Assets = rel.Assets[1:]
	a, err := pickPackageAsset(context.Background(), rel)
	if err != nil || a.Name != "" {
		t.Fatalf("legacy release unsupported: %v", err)
	}
}

func TestVoiceRuntimeProbeRequiresRuntimeReadiness(t *testing.T) {
	dir := t.TempDir()
	helper := filepath.Join(dir, "helper")
	// An executable with a working --build-commit is insufficient if it cannot
	// initialize the runtime. Never publish such a candidate.
	writeBackgroundExecutable(t, helper, "#!/bin/sh\nprintf '\\000\\000\\000\\020{\"type\":\"ready\"}'\n/bin/cat >/dev/null\n")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := probeVoiceRuntime(ctx, helper, strings.Repeat("a", 40)); err == nil {
		t.Fatal("canceled probe passed")
	}
	writeBackgroundExecutable(t, helper, "#!/bin/sh\nprintf '\\000\\000\\000\\020{\"type\":\"ready\"}'\nexit 1\n")
	if err := probeVoiceRuntime(context.Background(), helper, strings.Repeat("a", 40)); err == nil {
		t.Fatal("missing runtimeReady passed")
	}
}

func TestPackageDigestFailureDoesNotFallbackToStandalone(t *testing.T) {
	archive := packageFixture(t, nil)
	_, before := backgroundFixture(t, backgroundReleaseFixture{fullPackage: func() []byte { return archive }, badPackageDigest: true})
	err := EnsureCodexBackground(context.Background(), "9.9.9", true, nil)
	if !errors.Is(err, libcselect.ErrIntegrity) {
		t.Fatalf("digest error = %v", err)
	}
	after, _ := FindCLI()
	if after != before {
		t.Fatal("corrupt package fell back to standalone")
	}
}
