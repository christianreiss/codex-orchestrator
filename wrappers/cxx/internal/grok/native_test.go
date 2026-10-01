package grok

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
)

func archiveFixture(t *testing.T, binary []byte, names ...string) ([]byte, string) {
	t.Helper()
	var compressed bytes.Buffer
	br := brotli.NewWriter(&compressed)
	if _, err := br.Write(binary); err != nil {
		t.Fatal(err)
	}
	if err := br.Close(); err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	for _, name := range names {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(compressed.Len()), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(compressed.Bytes()); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha512.Sum512(archive.Bytes())
	return archive.Bytes(), "sha512-" + base64.StdEncoding.EncodeToString(sum[:])
}
func TestExtractBinaryVerifiesArchiveAndOnlyAllowedMember(t *testing.T) {
	data, integrity := archiveFixture(t, []byte("native fixture"), "package/bin/grok.br")
	got, err := ExtractBinary(data, integrity)
	if err != nil || string(got) != "native fixture" {
		t.Fatalf("extract=%q,%v", got, err)
	}
	tampered := append([]byte(nil), data...)
	tampered[len(tampered)-1] ^= 1
	if _, err := ExtractBinary(tampered, integrity); err == nil {
		t.Fatal("tampered archive accepted")
	}
	if _, err := ExtractBinary(data, "sha256-invalid"); err == nil {
		t.Fatal("weak integrity accepted")
	}
	for _, names := range [][]string{{"../../grok.br"}, {"package/bin/grok.br", "package/bin/grok.br"}} {
		data, integrity := archiveFixture(t, []byte("fixture"), names...)
		if _, err := ExtractBinary(data, integrity); err == nil {
			t.Fatalf("invalid members accepted: %v", names)
		}
	}
}
func TestPlatformPackages(t *testing.T) {
	for _, tt := range []struct{ os, arch, pkg string }{{"linux", "amd64", "@xai-official/grok-linux-x64"}, {"linux", "arm64", "@xai-official/grok-linux-arm64"}, {"darwin", "amd64", "@xai-official/grok-darwin-x64"}, {"darwin", "arm64", "@xai-official/grok-darwin-arm64"}} {
		got, err := PlatformPackage(tt.os, tt.arch)
		if err != nil || got != tt.pkg {
			t.Fatalf("%s/%s=%q,%v", tt.os, tt.arch, got, err)
		}
	}
	if _, err := PlatformPackage("windows", "amd64"); err == nil {
		t.Fatal("unsupported platform accepted")
	}
}

type fixtureTransport func(*http.Request) (*http.Response, error)

func (f fixtureTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestInstallerStagesChecksVersionAndPreservesPreviousOnFailure(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GROK_HOME", filepath.Join(t.TempDir(), "native"))
	t.Setenv("CGX_GROK_BIN", "")
	state, _ := StateDir()
	pointer := filepath.Join(state, "grok-bin")
	if err := AtomicWrite(pointer, []byte("previous-selected-binary\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	archive, integrity := archiveFixture(t, []byte("#!/bin/sh\nprintf 'grok 1.0.46\\n'\n"), "package/bin/grok.br")
	metadata := func(integrity string) []byte {
		m := packageMetadata{Version: PinnedVersion}
		m.Dist.Integrity = integrity
		m.Dist.Tarball = "https://registry.npmjs.org/@xai-official/grok/-/native.tgz"
		data, _ := json.Marshal(m)
		return data
	}
	client := &http.Client{Transport: fixtureTransport(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "registry.npmjs.org" {
			t.Fatalf("unexpected download host %s", req.URL.Host)
		}
		body := metadata(integrity)
		if strings.HasSuffix(req.URL.Path, ".tgz") {
			body = archive
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
	})}
	path, err := installWithClient(context.Background(), PinnedVersion, client)
	if err != nil {
		t.Fatal(err)
	}
	selected, _ := os.ReadFile(pointer)
	if strings.TrimSpace(string(selected)) != path {
		t.Fatal("installer did not switch after successful probe")
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0o700 {
		t.Fatalf("binary permissions=%o", st.Mode().Perm())
	}
	archive, integrity = archiveFixture(t, []byte("#!/bin/sh\nprintf 'grok 9.9.9\\n'\n"), "package/bin/grok.br")
	if _, err := installWithClient(context.Background(), PinnedVersion, client); err == nil {
		t.Fatal("wrong native version accepted")
	}
	after, _ := os.ReadFile(pointer)
	if !bytes.Equal(after, selected) {
		t.Fatal("failed update changed selected binary")
	}
	root, _ := StoreDir()
	entries, _ := os.ReadDir(root)
	if len(entries) != 2 {
		t.Fatalf("failed stage left debris: %v", entries)
	}
}

func TestInstallerRejectsForeignOriginBeforeDownload(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	calls := 0
	client := &http.Client{Transport: fixtureTransport(func(req *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"version":"1.0.46","dist":{"tarball":"https://example.invalid/native.tgz","integrity":"sha512-invalid"}}`)), Header: make(http.Header)}, nil
	})}
	if _, err := installWithClient(context.Background(), PinnedVersion, client); err == nil {
		t.Fatal("foreign package accepted")
	}
	if calls != 1 {
		t.Fatalf("foreign download attempted: %d calls", calls)
	}
}
