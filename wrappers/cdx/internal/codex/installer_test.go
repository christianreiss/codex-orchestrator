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
