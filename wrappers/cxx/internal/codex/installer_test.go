package codex

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPickAsset(t *testing.T) {
	rel := Release{
		Name:    "rust-v0.50.0",
		TagName: "rust-v0.50.0",
		Assets: []Asset{
			{Name: "codex-x86_64-unknown-linux-musl", DownloadURL: "u1", Digest: "sha256:aa"},
			{Name: "codex-x86_64-unknown-linux-musl.tar.gz", DownloadURL: "u1tgz", Digest: "sha256:bb"},
			{Name: "codex-aarch64-unknown-linux-musl.tar.gz", DownloadURL: "u2", Digest: "sha256:cc"},
			{Name: "codex-aarch64-apple-darwin.tar.gz", DownloadURL: "u3", Digest: "sha256:dd"},
			{Name: "codex-x86_64-apple-darwin.tar.gz", DownloadURL: "u4", Digest: "sha256:ee"},
			{Name: "codex-x86_64-pc-windows-msvc.exe.zip", DownloadURL: "uw", Digest: "sha256:ff"},
		},
	}

	tests := []struct {
		goos, goarch string
		wantName     string
		wantErr      bool
	}{
		{"linux", "amd64", "codex-x86_64-unknown-linux-musl.tar.gz", false},
		{"linux", "arm64", "codex-aarch64-unknown-linux-musl.tar.gz", false},
		{"darwin", "arm64", "codex-aarch64-apple-darwin.tar.gz", false},
		{"darwin", "amd64", "codex-x86_64-apple-darwin.tar.gz", false},
		{"windows", "amd64", "", true},
		{"freebsd", "amd64", "", true},
	}
	for _, tc := range tests {
		t.Run(tc.goos+"/"+tc.goarch, func(t *testing.T) {
			got, err := pickAsset(rel, tc.goos, tc.goarch)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want err, got asset %s", got.Name)
				}
				return
			}
			if err != nil {
				t.Fatalf("pickAsset: %v", err)
			}
			if got.Name != tc.wantName {
				t.Errorf("name=%s want %s", got.Name, tc.wantName)
			}
		})
	}
}

func TestPickAssetPrefersTarballOverRawBinary(t *testing.T) {
	rel := Release{
		Assets: []Asset{
			{Name: "codex-x86_64-unknown-linux-musl", DownloadURL: "raw", Digest: "sha256:aa"},
			{Name: "codex-x86_64-unknown-linux-musl.tar.gz", DownloadURL: "tgz", Digest: "sha256:bb"},
		},
	}
	got, err := pickAsset(rel, "linux", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "codex-x86_64-unknown-linux-musl.tar.gz" {
		t.Fatalf("got %s", got.Name)
	}
}

func TestPickAssetFallsBackToRawBinaryWhenNoTarball(t *testing.T) {
	rel := Release{
		Assets: []Asset{
			{Name: "codex-x86_64-unknown-linux-musl", DownloadURL: "raw", Digest: "sha256:aa"},
		},
	}
	got, err := pickAsset(rel, "linux", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "codex-x86_64-unknown-linux-musl" {
		t.Fatalf("got %s", got.Name)
	}
}

func TestInstallFromTarball(t *testing.T) {
	dir := t.TempDir()
	tarPath := filepath.Join(dir, "codex.tar.gz")

	// Build a tiny tar.gz containing a fake "codex" binary.
	payload := []byte("#!/bin/sh\necho fake codex\n")
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{
		Name:     "codex",
		Mode:     0o755,
		Size:     int64(len(payload)),
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tarPath, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(dir, "bin", "codex")
	if err := installFromTarball(tarPath, dest); err != nil {
		t.Fatalf("installFromTarball: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("dest content mismatch")
	}
	fi, err := os.Stat(dest)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o111 == 0 {
		t.Errorf("dest not executable: %v", fi.Mode())
	}
}

func TestEnsureCodexGitHubHappyPath(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skipf("happy-path fixture is linux/amd64 only; running on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	dir := t.TempDir()

	// Build a tar.gz with a fake codex binary.
	payload := []byte("#!/bin/sh\necho fake codex 0.50.0\n")
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "codex", Mode: 0o755, Size: int64(len(payload)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(payload)
	_ = tw.Close()
	_ = gz.Close()
	tarBytes := buf.Bytes()
	sum := sha256.Sum256(tarBytes)
	expectedSha := hex.EncodeToString(sum[:])

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/openai/codex/releases/tags/v0.50.0", func(w http.ResponseWriter, r *http.Request) {
		rel := Release{
			Name:    "rust-v0.50.0",
			TagName: "v0.50.0",
			Assets: []Asset{
				{
					Name:        "codex-x86_64-unknown-linux-musl.tar.gz",
					DownloadURL: "http://" + r.Host + "/asset.tar.gz",
					Digest:      "sha256:" + expectedSha,
					Size:        int64(len(tarBytes)),
				},
			},
		}
		_ = json.NewEncoder(w).Encode(rel)
	})
	mux.HandleFunc("/asset.tar.gz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/gzip")
		_, _ = w.Write(tarBytes)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prevBase := githubBaseURL
	githubBaseURL = srv.URL
	t.Cleanup(func() { githubBaseURL = prevBase })

	// Re-route the install destination so root test runs never touch the real
	// system codex binary.
	t.Setenv("HOME", dir)
	t.Setenv("CDX_CODEX_INSTALL_DIR", filepath.Join(dir, ".local", "bin"))

	// Force the GitHub path (not npm): unset PATH so FindCLI/isManagedByNpm fail.
	t.Setenv("PATH", "")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist") // ensures FindCLI errors

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := EnsureCodex(context.Background(), "0.50.0", true, logger)
	if err != nil {
		t.Fatalf("EnsureCodex: %v", err)
	}

	dest := filepath.Join(dir, ".local", "bin", "codex")
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read installed codex: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("installed codex content mismatch")
	}
}

func TestEnsureCodexGitHubAbortsOnShaMismatch(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("linux/amd64 fixture")
	}
	dir := t.TempDir()

	payload := []byte("real-bytes")
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "codex", Mode: 0o755, Size: int64(len(payload)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(payload)
	_ = tw.Close()
	_ = gz.Close()

	// Server advertises a SHA that doesn't match the actual tarball.
	wrongSHA := strings.Repeat("0", 64)

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/openai/codex/releases/tags/v0.50.0", func(w http.ResponseWriter, r *http.Request) {
		rel := Release{
			TagName: "v0.50.0",
			Assets: []Asset{
				{
					Name:        "codex-x86_64-unknown-linux-musl.tar.gz",
					DownloadURL: "http://" + r.Host + "/asset.tar.gz",
					Digest:      "sha256:" + wrongSHA,
				},
			},
		}
		_ = json.NewEncoder(w).Encode(rel)
	})
	mux.HandleFunc("/asset.tar.gz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(buf.Bytes())
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prevBase := githubBaseURL
	githubBaseURL = srv.URL
	t.Cleanup(func() { githubBaseURL = prevBase })

	t.Setenv("HOME", dir)
	t.Setenv("PATH", "")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := EnsureCodex(context.Background(), "0.50.0", true, logger)
	if err == nil {
		t.Fatal("expected sha mismatch error")
	}
	if !strings.Contains(err.Error(), "sha mismatch") {
		t.Errorf("unexpected error: %v", err)
	}
	// Make sure nothing was installed.
	if _, err := os.Stat(filepath.Join(dir, ".local", "bin", "codex")); err == nil {
		t.Errorf("partial install left behind")
	}
}

func TestEnsureCodexGitHubAbortsOnMissingDigest(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("linux/amd64 fixture")
	}
	dir := t.TempDir()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/openai/codex/releases/tags/v0.50.0", func(w http.ResponseWriter, r *http.Request) {
		rel := Release{
			TagName: "v0.50.0",
			Assets: []Asset{
				{
					Name:        "codex-x86_64-unknown-linux-musl.tar.gz",
					DownloadURL: "http://example.invalid/x",
					Digest:      "",
				},
			},
		}
		_ = json.NewEncoder(w).Encode(rel)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	prevBase := githubBaseURL
	githubBaseURL = srv.URL
	t.Cleanup(func() { githubBaseURL = prevBase })

	t.Setenv("HOME", dir)
	t.Setenv("PATH", "")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := EnsureCodex(context.Background(), "0.50.0", true, logger)
	if err == nil {
		t.Fatal("expected missing-digest error")
	}
	if !strings.Contains(err.Error(), "no sha256 digest") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestEnsureCodexLatestSkipsWhenCurrentMatchesResolvedRelease(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(bin, "codex")
	if err := os.WriteFile(codexPath, []byte("#!/bin/sh\necho codex-cli 0.50.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/openai/codex/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		rel := Release{Name: "0.50.0", TagName: "rust-v0.50.0"}
		_ = json.NewEncoder(w).Encode(rel)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prevBase := githubBaseURL
	githubBaseURL = srv.URL
	t.Cleanup(func() { githubBaseURL = prevBase })

	t.Setenv("PATH", bin)
	t.Setenv("CDX_CODEX_BIN", codexPath)
	// Isolate the codex-code-mode-host state marker from the real machine —
	// EnsureCodex's companion check now runs on this fast path too.
	t.Setenv("HOME", dir)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := EnsureCodex(context.Background(), "latest", false, logger); err != nil {
		t.Fatalf("EnsureCodex: %v", err)
	}
}

func TestReleaseTagCandidates(t *testing.T) {
	tests := []struct {
		target string
		want   []string
	}{
		{"", []string{"/releases/latest"}},
		{"latest", []string{"/releases/latest"}},
		{"0.50.0", []string{"/releases/tags/0.50.0", "/releases/tags/v0.50.0", "/releases/tags/rust-0.50.0", "/releases/tags/rust-v0.50.0"}},
		{"v0.50.0", []string{"/releases/tags/v0.50.0", "/releases/tags/rust-v0.50.0", "/releases/tags/rust-vv0.50.0"}},
	}
	for _, tc := range tests {
		got := releaseTagCandidates(tc.target)
		if len(got) != len(tc.want) {
			t.Errorf("target=%q: got %v want %v", tc.target, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("target=%q[%d]: got %s want %s", tc.target, i, got[i], tc.want[i])
			}
		}
	}
}

// --- codex-code-mode-host companion -----------------------------------------

func TestPickAssetForCompanionBinary(t *testing.T) {
	rel := Release{
		Name:    "rust-v0.147.0",
		TagName: "rust-v0.147.0",
		Assets: []Asset{
			{Name: "codex-x86_64-unknown-linux-musl.tar.gz", DownloadURL: "codex-url", Digest: "sha256:aa"},
			{Name: "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz", DownloadURL: "companion-url", Digest: "sha256:bb"},
		},
	}

	codexAsset, err := pickAsset(rel, "linux", "amd64")
	if err != nil {
		t.Fatalf("pickAsset: %v", err)
	}
	if codexAsset.DownloadURL != "codex-url" {
		t.Errorf("pickAsset picked %q, want the codex asset", codexAsset.Name)
	}

	companionAsset, err := pickAssetFor(rel, "codex-code-mode-host", "linux", "amd64")
	if err != nil {
		t.Fatalf("pickAssetFor: %v", err)
	}
	if companionAsset.DownloadURL != "companion-url" {
		t.Errorf("pickAssetFor picked %q, want the companion asset", companionAsset.Name)
	}
}

func TestInstallFromTarballNamedFullStemEntry(t *testing.T) {
	dir := t.TempDir()
	tarPath := filepath.Join(dir, "companion.tar.gz")

	// Real upstream convention: the tar entry is named with the full,
	// platform-qualified asset stem, not the bare binary name.
	payload := []byte("#!/bin/sh\necho fake code-mode-host\n")
	entryName := "codex-code-mode-host-x86_64-unknown-linux-musl"
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: entryName, Mode: 0o755, Size: int64(len(payload)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(payload)
	_ = tw.Close()
	_ = gz.Close()
	if err := os.WriteFile(tarPath, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(dir, "bin", "codex-code-mode-host")
	exactNames := []string{"codex-code-mode-host", entryName}
	if err := installFromTarballNamed(tarPath, dest, exactNames, "codex-code-mode-host"); err != nil {
		t.Fatalf("installFromTarballNamed: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("dest content mismatch")
	}
}

func TestInstallFromTarballNamedDecoyBeforeReal(t *testing.T) {
	dir := t.TempDir()
	tarPath := filepath.Join(dir, "companion.tar.gz")

	decoyPayload := []byte("LICENSE TEXT")
	realPayload := []byte("#!/bin/sh\necho real code-mode-host\n")
	entryName := "codex-code-mode-host-x86_64-unknown-linux-musl"

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "codex-code-mode-host-LICENSE", Mode: 0o644, Size: int64(len(decoyPayload)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(decoyPayload)
	_ = tw.WriteHeader(&tar.Header{Name: entryName, Mode: 0o755, Size: int64(len(realPayload)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(realPayload)
	_ = tw.Close()
	_ = gz.Close()
	if err := os.WriteFile(tarPath, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(dir, "bin", "codex-code-mode-host")
	exactNames := []string{"codex-code-mode-host", entryName}
	if err := installFromTarballNamed(tarPath, dest, exactNames, "codex-code-mode-host"); err != nil {
		t.Fatalf("installFromTarballNamed: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, realPayload) {
		t.Errorf("decoy file was installed instead of the real binary")
	}
}

func TestEnsureCodeModeHostInstalledWhenMissing(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("linux/amd64 fixture")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(bin, "codex")
	if err := os.WriteFile(codexPath, []byte("#!/bin/sh\necho codex-cli 0.50.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	payload := []byte("#!/bin/sh\necho fake code-mode-host\n")
	entryName := "codex-code-mode-host-x86_64-unknown-linux-musl"
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: entryName, Mode: 0o755, Size: int64(len(payload)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(payload)
	_ = tw.Close()
	_ = gz.Close()
	tarBytes := buf.Bytes()
	sum := sha256.Sum256(tarBytes)
	expectedSha := hex.EncodeToString(sum[:])

	mux := http.NewServeMux()
	// releaseTagCandidates("0.50.0") tries "0.50.0" first (no "v" prefix).
	mux.HandleFunc("/repos/openai/codex/releases/tags/0.50.0", func(w http.ResponseWriter, r *http.Request) {
		rel := Release{
			Name:    "rust-v0.50.0",
			TagName: "v0.50.0",
			Assets: []Asset{
				{
					Name:        entryName + ".tar.gz",
					DownloadURL: "http://" + r.Host + "/asset.tar.gz",
					Digest:      "sha256:" + expectedSha,
					Size:        int64(len(tarBytes)),
				},
			},
		}
		_ = json.NewEncoder(w).Encode(rel)
	})
	mux.HandleFunc("/asset.tar.gz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(tarBytes)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prevBase := githubBaseURL
	githubBaseURL = srv.URL
	t.Cleanup(func() { githubBaseURL = prevBase })

	t.Setenv("HOME", dir)
	t.Setenv("PATH", bin)
	t.Setenv("CDX_CODEX_BIN", codexPath)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	// enforceExact=false, target == current ("0.50.0") -> codex's own fast
	// path skips, but the companion is missing so it should still install.
	if err := EnsureCodex(context.Background(), "0.50.0", false, logger); err != nil {
		t.Fatalf("EnsureCodex: %v", err)
	}

	dest := filepath.Join(bin, "codex-code-mode-host")
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read installed companion: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("companion content mismatch")
	}

	state := readCodeModeHostState()
	if state.InstalledFor != "0.50.0" {
		t.Errorf("marker InstalledFor = %q, want 0.50.0", state.InstalledFor)
	}
}

func TestEnsureCodeModeHostRefreshedAfterCodexUpdate(t *testing.T) {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Skip("linux/amd64 fixture")
	}
	dir := t.TempDir()

	codexPayload := []byte("#!/bin/sh\necho fake codex 0.50.0\n")
	var codexBuf bytes.Buffer
	gz := gzip.NewWriter(&codexBuf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "codex", Mode: 0o755, Size: int64(len(codexPayload)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(codexPayload)
	_ = tw.Close()
	_ = gz.Close()
	codexTarBytes := codexBuf.Bytes()
	codexSum := sha256.Sum256(codexTarBytes)
	codexSha := hex.EncodeToString(codexSum[:])

	companionPayload := []byte("#!/bin/sh\necho fake code-mode-host\n")
	companionEntry := "codex-code-mode-host-x86_64-unknown-linux-musl"
	var companionBuf bytes.Buffer
	gz2 := gzip.NewWriter(&companionBuf)
	tw2 := tar.NewWriter(gz2)
	_ = tw2.WriteHeader(&tar.Header{Name: companionEntry, Mode: 0o755, Size: int64(len(companionPayload)), Typeflag: tar.TypeReg})
	_, _ = tw2.Write(companionPayload)
	_ = tw2.Close()
	_ = gz2.Close()
	companionTarBytes := companionBuf.Bytes()
	companionSum := sha256.Sum256(companionTarBytes)
	companionSha := hex.EncodeToString(companionSum[:])

	var tagRequests int32
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/openai/codex/releases/tags/v0.50.0", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&tagRequests, 1)
		rel := Release{
			Name:    "rust-v0.50.0",
			TagName: "v0.50.0",
			Assets: []Asset{
				{
					Name:        "codex-x86_64-unknown-linux-musl.tar.gz",
					DownloadURL: "http://" + r.Host + "/codex.tar.gz",
					Digest:      "sha256:" + codexSha,
					Size:        int64(len(codexTarBytes)),
				},
				{
					Name:        companionEntry + ".tar.gz",
					DownloadURL: "http://" + r.Host + "/companion.tar.gz",
					Digest:      "sha256:" + companionSha,
					Size:        int64(len(companionTarBytes)),
				},
			},
		}
		_ = json.NewEncoder(w).Encode(rel)
	})
	mux.HandleFunc("/codex.tar.gz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(codexTarBytes)
	})
	mux.HandleFunc("/companion.tar.gz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(companionTarBytes)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prevBase := githubBaseURL
	githubBaseURL = srv.URL
	t.Cleanup(func() { githubBaseURL = prevBase })

	t.Setenv("HOME", dir)
	t.Setenv("CDX_CODEX_INSTALL_DIR", filepath.Join(dir, ".local", "bin"))
	t.Setenv("PATH", "")
	t.Setenv("CDX_CODEX_BIN", "/does/not/exist")

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := EnsureCodex(context.Background(), "0.50.0", true, logger); err != nil {
		t.Fatalf("EnsureCodex: %v", err)
	}

	installDir := filepath.Join(dir, ".local", "bin")
	gotCodex, err := os.ReadFile(filepath.Join(installDir, "codex"))
	if err != nil {
		t.Fatalf("read installed codex: %v", err)
	}
	if !bytes.Equal(gotCodex, codexPayload) {
		t.Errorf("codex content mismatch")
	}
	gotCompanion, err := os.ReadFile(filepath.Join(installDir, "codex-code-mode-host"))
	if err != nil {
		t.Fatalf("read installed companion: %v", err)
	}
	if !bytes.Equal(gotCompanion, companionPayload) {
		t.Errorf("companion content mismatch")
	}

	if got := atomic.LoadInt32(&tagRequests); got != 1 {
		t.Errorf("expected exactly 1 release-tag request (release reuse, no redundant fetch), got %d", got)
	}
}

func TestEnsureCodeModeHostFailureDoesNotFailEnsureCodex(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(bin, "codex")
	if err := os.WriteFile(codexPath, []byte("#!/bin/sh\necho codex-cli 0.50.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	// No handlers registered — every release lookup 404s, so the companion
	// fetch fails outright.
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prevBase := githubBaseURL
	githubBaseURL = srv.URL
	t.Cleanup(func() { githubBaseURL = prevBase })

	t.Setenv("HOME", dir)
	t.Setenv("PATH", bin)
	t.Setenv("CDX_CODEX_BIN", codexPath)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := EnsureCodex(context.Background(), "0.50.0", false, logger); err != nil {
		t.Fatalf("EnsureCodex should swallow companion failure, got: %v", err)
	}

	state := readCodeModeHostState()
	if state.LastAttemptFailedAt == "" {
		t.Errorf("expected the failed attempt to be recorded in the marker")
	}
}

func TestEnsureCodeModeHostSkippedOnNpmManagedPath(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(bin, "codex")
	if err := os.WriteFile(codexPath, []byte("#!/bin/sh\necho codex-cli 0.50.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	npmPath := filepath.Join(bin, "npm")
	if err := os.WriteFile(npmPath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	var requests int32
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prevBase := githubBaseURL
	githubBaseURL = srv.URL
	t.Cleanup(func() { githubBaseURL = prevBase })

	t.Setenv("HOME", dir)
	t.Setenv("PATH", bin)
	t.Setenv("CDX_CODEX_BIN", codexPath)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	// isManagedByNpm will be true (fake npm on PATH exits 0), and codex is
	// already at target, so this must never touch the network at all —
	// npm-managed hosts are out of scope for the companion install.
	if err := EnsureCodex(context.Background(), "0.50.0", false, logger); err != nil {
		t.Fatalf("EnsureCodex: %v", err)
	}

	if got := atomic.LoadInt32(&requests); got != 0 {
		t.Errorf("expected zero network requests on npm-managed path, got %d", got)
	}
}

func TestEnsureCodeModeHostDestMatchesCodexDir(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "somewhere", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(bin, "codex")
	if err := os.WriteFile(codexPath, []byte("#!/bin/sh\necho codex-cli 0.50.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("HOME", dir)
	t.Setenv("CDX_CODEX_BIN", codexPath)

	got := companionInstallDir()
	if got != bin {
		t.Errorf("companionInstallDir() = %q, want %q", got, bin)
	}
}

func TestEnsureCodeModeHostSteadyStateNoRequests(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(bin, "codex")
	if err := os.WriteFile(codexPath, []byte("#!/bin/sh\necho codex-cli 0.50.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	companionPath := filepath.Join(bin, "codex-code-mode-host")
	if err := os.WriteFile(companionPath, []byte("#!/bin/sh\necho fake\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("HOME", dir)
	t.Setenv("PATH", bin)
	t.Setenv("CDX_CODEX_BIN", codexPath)

	// Pre-seed the marker as already matching, mirroring a converged host.
	if err := writeCodeModeHostState(codeModeHostState{InstalledFor: "0.50.0"}); err != nil {
		t.Fatal(err)
	}

	var requests int32
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prevBase := githubBaseURL
	githubBaseURL = srv.URL
	t.Cleanup(func() { githubBaseURL = prevBase })

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := EnsureCodex(context.Background(), "0.50.0", false, logger); err != nil {
		t.Fatalf("EnsureCodex: %v", err)
	}

	if got := atomic.LoadInt32(&requests); got != 0 {
		t.Errorf("expected zero network requests in steady state, got %d", got)
	}
}
