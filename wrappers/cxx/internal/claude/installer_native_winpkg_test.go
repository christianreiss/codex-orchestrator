package claude

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudePlatformPackageForOS(t *testing.T) {
	for _, tc := range []struct {
		goos, goarch string
		musl         bool
		want         string
	}{
		{"windows", "amd64", false, "@anthropic-ai/claude-code-win32-x64"},
		{"windows", "arm64", false, "@anthropic-ai/claude-code-win32-arm64"},
		{"windows", "amd64", true, "@anthropic-ai/claude-code-win32-x64"}, // no musl logic
		{"windows", "386", false, ""},
		{"linux", "amd64", false, "@anthropic-ai/claude-code-linux-x64"},
		{"linux", "arm64", false, "@anthropic-ai/claude-code-linux-arm64"},
		{"linux", "amd64", true, "@anthropic-ai/claude-code-linux-x64-musl"},
		{"linux", "arm64", true, "@anthropic-ai/claude-code-linux-arm64-musl"},
		{"darwin", "amd64", false, "@anthropic-ai/claude-code-darwin-x64"},
		{"darwin", "arm64", false, "@anthropic-ai/claude-code-darwin-arm64"},
		{"freebsd", "amd64", false, ""},
	} {
		if got := claudePlatformPackageForOS(tc.goos, tc.goarch, tc.musl); got != tc.want {
			t.Errorf("%s/%s musl=%v = %q, want %q", tc.goos, tc.goarch, tc.musl, got, tc.want)
		}
	}
}

func claudeTarball(t *testing.T, members map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	// Deterministic order is irrelevant: the extractor scans for the member.
	for name, body := range members {
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
	p := filepath.Join(t.TempDir(), "package.tgz")
	if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExtractClaudeBinaryForMemberNames(t *testing.T) {
	for _, tc := range []struct {
		name    string
		goos    string
		members map[string]string
		wantErr string
		want    string
	}{
		{"windows takes claude.exe", "windows", map[string]string{"package/claude.exe": "MZ win", "package/package.json": "{}"}, "", "MZ win"},
		{"windows rejects unix member", "windows", map[string]string{"package/claude": "ELF"}, "package/claude.exe not found", ""},
		{"windows rejects nested exe", "windows", map[string]string{"package/bin/claude.exe": "MZ"}, "package/claude.exe not found", ""},
		{"windows rejects traversal", "windows", map[string]string{"../claude.exe": "MZ", "package/../claude.exe": "MZ"}, "not found", ""},
		{"linux takes claude", "linux", map[string]string{"package/claude": "ELF"}, "", "ELF"},
		{"linux rejects exe member", "linux", map[string]string{"package/claude.exe": "MZ"}, "package/claude not found", ""},
		{"darwin rejects exe member", "darwin", map[string]string{"package/claude.exe": "MZ"}, "package/claude not found", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "bin", claudeBinaryName(tc.goos))
			err := extractClaudeBinaryFor(tc.goos, claudeTarball(t, tc.members), dest)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
				}
				if _, statErr := os.Stat(dest); statErr == nil {
					t.Fatal("binary written despite rejection")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(dest)
			if string(got) != tc.want {
				t.Fatalf("content %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClaudeBinaryName(t *testing.T) {
	if claudeBinaryName("windows") != "claude.exe" || claudeBinaryName("linux") != "claude" || claudeBinaryName("darwin") != "claude" {
		t.Fatal("unexpected binary names")
	}
}

// The sha512 integrity gate is OS-independent; pin it for a Windows-shaped
// tarball so a regression cannot slip in through the new member name.
func TestDownloadClaudeTarballVerifiesSha512ForWindowsPackage(t *testing.T) {
	tgz := claudeTarball(t, map[string]string{"package/claude.exe": "MZ win"})
	body, err := os.ReadFile(tgz)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
	defer srv.Close()
	sum := sha512.Sum512(body)

	good := filepath.Join(t.TempDir(), "ok.tgz")
	if err := downloadClaudeTarball(context.Background(), srv.URL, good, sum[:]); err != nil {
		t.Fatalf("matching integrity rejected: %v", err)
	}
	bad := append([]byte(nil), sum[:]...)
	bad[0] ^= 0xff
	badDest := filepath.Join(t.TempDir(), "bad.tgz")
	if err := downloadClaudeTarball(context.Background(), srv.URL, badDest, bad); err == nil || !strings.Contains(err.Error(), "sha512") {
		t.Fatalf("integrity mismatch not rejected: %v", err)
	}
}
