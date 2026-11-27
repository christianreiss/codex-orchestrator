package codex

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArchTripleIncludesWindows(t *testing.T) {
	for _, tc := range []struct {
		goos, goarch, want string
		wantErr            bool
	}{
		{"windows", "amd64", "x86_64-pc-windows-msvc", false},
		{"windows", "arm64", "aarch64-pc-windows-msvc", false},
		{"windows", "386", "", true},
		{"linux", "amd64", "x86_64-unknown-linux-musl", false},
		{"linux", "arm64", "aarch64-unknown-linux-musl", false},
		{"darwin", "arm64", "aarch64-apple-darwin", false},
		{"darwin", "amd64", "x86_64-apple-darwin", false},
		{"freebsd", "amd64", "", true},
	} {
		got, err := archTriple(tc.goos, tc.goarch)
		if (err != nil) != tc.wantErr || got != tc.want {
			t.Errorf("archTriple(%s,%s) = %q, %v; want %q (err=%v)", tc.goos, tc.goarch, got, err, tc.want, tc.wantErr)
		}
	}
}

func TestPickAssetForWindows(t *testing.T) {
	rel := Release{Assets: []Asset{
		{Name: "codex-x86_64-pc-windows-msvc.exe.zip", DownloadURL: "zip"},
		{Name: "codex-x86_64-pc-windows-msvc.exe.zst", DownloadURL: "zst"},
		{Name: "codex-x86_64-pc-windows-msvc.exe", DownloadURL: "raw"},
		{Name: "codex-x86_64-pc-windows-msvc.exe.tar.gz", DownloadURL: "tgz"},
		{Name: "codex-aarch64-pc-windows-msvc.exe.zip", DownloadURL: "azip"},
		{Name: "codex-aarch64-pc-windows-msvc.exe", DownloadURL: "araw"},
		{Name: "codex-code-mode-host-x86_64-pc-windows-msvc.exe.tar.gz", DownloadURL: "host"},
		{Name: "codex-command-runner-x86_64-pc-windows-msvc.exe.tar.gz", DownloadURL: "runner"},
	}}
	for _, tc := range []struct{ bin, goarch, want string }{
		{"codex", "amd64", "codex-x86_64-pc-windows-msvc.exe.tar.gz"},
		{"codex", "arm64", "codex-aarch64-pc-windows-msvc.exe"}, // zip is not installable; raw .exe is
		{codeModeHostBinName, "amd64", "codex-code-mode-host-x86_64-pc-windows-msvc.exe.tar.gz"},
	} {
		got, err := pickAssetFor(rel, tc.bin, "windows", tc.goarch)
		if err != nil || got.Name != tc.want {
			t.Errorf("pickAssetFor(%s, windows/%s) = %q, %v; want %q", tc.bin, tc.goarch, got.Name, err, tc.want)
		}
	}
	// Only unpackable archives: refuse rather than install a .zip as a binary.
	onlyZip := Release{Assets: []Asset{{Name: "codex-x86_64-pc-windows-msvc.exe.zip"}, {Name: "codex-x86_64-pc-windows-msvc.exe.zst"}}}
	if got, err := pickAssetFor(onlyZip, "codex", "windows", "amd64"); err == nil {
		t.Fatalf("picked unusable asset %q", got.Name)
	}
}

func TestPickPackageAssetForWindows(t *testing.T) {
	rel := Release{Assets: []Asset{
		{Name: "codex-package-x86_64-pc-windows-msvc.tar.zst"},
		{Name: "codex-package-x86_64-pc-windows-msvc.tar.gz", Digest: "sha256:a"},
		{Name: "codex-package-aarch64-pc-windows-msvc.tar.gz", Digest: "sha256:b"},
		{Name: "codex-package-x86_64-unknown-linux-musl.tar.gz"},
	}}
	for goarch, want := range map[string]string{
		"amd64": "codex-package-x86_64-pc-windows-msvc.tar.gz",
		"arm64": "codex-package-aarch64-pc-windows-msvc.tar.gz",
	} {
		got, err := pickPackageAssetFor(context.Background(), rel, "windows", goarch)
		if err != nil || got.Name != want {
			t.Errorf("windows/%s = %q, %v; want %q", goarch, got.Name, err, want)
		}
	}
	// A release with packages but none for this platform must fail, not fall back.
	linuxOnly := Release{Assets: []Asset{{Name: "codex-package-x86_64-unknown-linux-musl.tar.gz"}}}
	if _, err := pickPackageAssetFor(context.Background(), linuxOnly, "windows", "amd64"); err == nil {
		t.Fatal("missing Windows package fell back to standalone")
	}
	if _, err := pickPackageAssetFor(context.Background(), rel, "windows", "386"); err == nil {
		t.Fatal("unsupported arch accepted")
	}
}

func TestRegularFileForExecBit(t *testing.T) {
	p := filepath.Join(t.TempDir(), "codex.exe")
	if err := os.WriteFile(p, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !regularFileFor("windows", p, true) {
		t.Error("windows must not require an exec bit")
	}
	for _, goos := range []string{"linux", "darwin", "freebsd"} {
		if regularFileFor(goos, p, true) {
			t.Errorf("%s accepted a non-executable file as executable", goos)
		}
		if !regularFileFor(goos, p, false) {
			t.Errorf("%s rejected a regular file", goos)
		}
	}
	empty := filepath.Join(t.TempDir(), "empty.exe")
	if err := os.WriteFile(empty, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if regularFileFor("windows", empty, true) {
		t.Error("empty file accepted")
	}
	if regularFileFor("windows", t.TempDir(), false) {
		t.Error("directory accepted")
	}
}

func TestPackageLayoutFor(t *testing.T) {
	w := packageLayoutFor("windows")
	for got, want := range map[string]string{
		w.entrypoint: "bin/codex.exe",
		w.companion:  "bin/codex-code-mode-host.exe",
		w.execServer: "bin/codex-exec-server.exe",
		w.rg:         "codex-path/rg.exe",
		w.voiceHost:  "codex-resources/voice/bin/codex-voice-host.exe",
		w.voiceLib:   "codex-resources/voice/bin/gstreamer-1.0-0.dll",
	} {
		if got != want {
			t.Errorf("windows layout %q, want %q", got, want)
		}
	}
	l := packageLayoutFor("linux")
	if l.entrypoint != "bin/codex" || l.rg != "codex-path/rg" || l.voiceHost != "codex-resources/voice/bin/codex-voice-host" || l.voiceLib != "codex-resources/voice/lib/libgstreamer-1.0.so.0" {
		t.Errorf("linux layout changed: %+v", l)
	}
	if d := packageLayoutFor("darwin"); d.voiceLib != "codex-resources/voice/lib/libgstreamer-1.0.0.dylib" || d.entrypoint != "bin/codex" {
		t.Errorf("darwin layout changed: %+v", d)
	}
}

const windowsTarget = "x86_64-pc-windows-msvc"

// windowsPackageFixture mirrors the shape of the official
// codex-package-x86_64-pc-windows-msvc.tar.gz (rust-v0.172.0), with tiny
// payloads and no exec bits on any member.
func windowsPackageFixture(t *testing.T, mutate func(map[string]string)) []byte {
	t.Helper()
	commit := strings.Repeat("b", 40)
	files := map[string]string{
		"bin/codex.exe":                                   "MZ codex",
		"bin/codex-code-mode-host.exe":                    "MZ host",
		"bin/codex-exec-server.exe":                       "MZ exec",
		"codex-path/rg.exe":                               "MZ rg",
		"codex-resources/codex-command-runner.exe":        "MZ runner",
		"codex-resources/codex-windows-sandbox-setup.exe": "MZ setup",
		"codex-resources/voice/bin/codex-voice-host.exe":  "MZ voice",
		"codex-resources/voice/bin/gstreamer-1.0-0.dll":   "MZ gst",
		"codex-resources/voice/runtime.json":              "{}\n",
	}
	meta, _ := json.Marshal(packageMetadata{LayoutVersion: 1, Version: "9.9.9", Target: windowsTarget, Entrypoint: "bin/codex.exe", ResourcesDir: "codex-resources"})
	files["codex-package.json"] = string(meta)
	m := voiceManifest{SchemaVersion: 1, BuildCommit: commit, AppTarget: windowsTarget, VoiceTarget: windowsTarget, AppVersion: "9.9.9", SHA256: make(map[string]string)}
	for name, body := range files {
		if name == "bin/codex.exe" || strings.HasPrefix(name, "codex-resources/voice/") {
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
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(body))}); err != nil {
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

func extractWindowsFixture(t *testing.T, mutate func(map[string]string)) string {
	t.Helper()
	archive := filepath.Join(t.TempDir(), "package.tar.gz")
	if err := os.WriteFile(archive, windowsPackageFixture(t, mutate), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := extractCodexPackage(context.Background(), archive, dir); err != nil {
		t.Fatalf("extract: %v", err)
	}
	return dir
}

func TestValidateWindowsPackage(t *testing.T) {
	ctx := context.Background()
	dir := extractWindowsFixture(t, nil)
	if err := validateCodexPackageFor(ctx, "windows", dir, "9.9.9", windowsTarget, true); err != nil {
		t.Fatalf("valid Windows package rejected: %v", err)
	}
	// The same bytes are not a valid Unix package: layout is OS-specific.
	if err := validateCodexPackageFor(ctx, "linux", dir, "9.9.9", "", true); err == nil {
		t.Fatal("Windows layout accepted on linux")
	}
	for _, tc := range []struct {
		name         string
		mutate       func(map[string]string)
		version, tgt string
	}{
		{"wrong version", nil, "1.0.0", windowsTarget},
		{"wrong target", nil, "9.9.9", "aarch64-pc-windows-msvc"},
		{"unix entrypoint", func(f map[string]string) {
			f["codex-package.json"] = strings.Replace(f["codex-package.json"], "bin/codex.exe", "bin/codex", 1)
		}, "9.9.9", windowsTarget},
		{"missing codex.exe", func(f map[string]string) { delete(f, "bin/codex.exe") }, "9.9.9", windowsTarget},
		{"missing rg.exe", func(f map[string]string) { delete(f, "codex-path/rg.exe") }, "9.9.9", windowsTarget},
		{"missing companion", func(f map[string]string) { delete(f, "bin/codex-code-mode-host.exe") }, "9.9.9", windowsTarget},
		{"missing exec-server", func(f map[string]string) { delete(f, "bin/codex-exec-server.exe") }, "9.9.9", windowsTarget},
		{"missing voice host", func(f map[string]string) { delete(f, "codex-resources/voice/bin/codex-voice-host.exe") }, "9.9.9", windowsTarget},
		{"hash mismatch", func(f map[string]string) { f["codex-resources/voice/bin/gstreamer-1.0-0.dll"] = "MZ tampered" }, "9.9.9", windowsTarget},
		{"cli hash mismatch", func(f map[string]string) { f["bin/codex.exe"] = "MZ tampered" }, "9.9.9", windowsTarget},
		{"manifest omits library", func(f map[string]string) {
			var m voiceManifest
			_ = json.Unmarshal([]byte(f["codex-resources/voice/manifest.json"]), &m)
			delete(m.SHA256, "codex-resources/voice/bin/gstreamer-1.0-0.dll")
			b, _ := json.Marshal(m)
			f["codex-resources/voice/manifest.json"] = string(b)
		}, "9.9.9", windowsTarget},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := extractWindowsFixture(t, tc.mutate)
			if err := validateCodexPackageFor(ctx, "windows", d, tc.version, tc.tgt, true); err == nil {
				t.Fatal("invalid Windows package accepted")
			}
		})
	}
}

func TestWindowsPackageExtractionKeepsSafetyChecks(t *testing.T) {
	// Backslash and drive-letter members must never reach the Windows filesystem.
	for _, name := range []string{`bin\codex.exe`, `C:/codex.exe`, `..\escape.exe`, "../escape.exe"} {
		var out bytes.Buffer
		gz := gzip.NewWriter(&out)
		tw := tar.NewWriter(gz)
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Typeflag: tar.TypeReg, Size: 2})
		_, _ = tw.Write([]byte("MZ"))
		_ = tw.Close()
		_ = gz.Close()
		archive := filepath.Join(t.TempDir(), "p.tgz")
		_ = os.WriteFile(archive, out.Bytes(), 0o600)
		if err := extractCodexPackage(context.Background(), archive, t.TempDir()); err == nil {
			t.Errorf("member %q accepted", name)
		}
	}
}
