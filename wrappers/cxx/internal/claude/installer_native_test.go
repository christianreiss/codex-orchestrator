package claude

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func nativeClaudeTarball(t *testing.T, version string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range map[string]string{
		"package/package.json": "{}",
		"../escape":            "nope",
		"package/claude":       "#!/bin/sh\necho '" + version + " (Claude Code)'\n",
	} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
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
	return buf.Bytes()
}

// nativeRegistry serves one platform package version; integrity is computed
// over wantBody so a caller can serve a different (tampered) tarball.
func nativeRegistry(t *testing.T, version string, served, wantBody []byte) {
	t.Helper()
	old := muslLoaderGlob
	muslLoaderGlob = filepath.Join(t.TempDir(), "no-musl-*")
	t.Cleanup(func() { muslLoaderGlob = old })
	sum := sha512.Sum512(wantBody)
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/"+claudePlatformPackage()+"/"+version:
			_ = json.NewEncoder(w).Encode(map[string]any{"dist": map[string]string{
				"tarball":   srv.URL + "/pkg.tgz",
				"integrity": "sha512-" + base64.StdEncoding.EncodeToString(sum[:]),
			}})
		case r.URL.Path == "/pkg.tgz":
			_, _ = w.Write(served)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("npm_config_registry", srv.URL+"/")
}

func TestBackgroundClaudeInstallsNativeBinaryWithoutNpm(t *testing.T) {
	home, bin := stagedInstallFixture(t)
	t.Setenv("PATH", bin)
	body := nativeClaudeTarball(t, "2.1.2")
	nativeRegistry(t, "2.1.2", body, body)
	if err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil); err != nil {
		t.Fatalf("native install: %v", err)
	}
	if got := Version(context.Background()); got != "2.1.2" {
		t.Fatalf("published version = %q", got)
	}
	cli, err := FindCLI()
	if err != nil || !isManagedClaudeCLI(cli) || filepath.Base(cli) != "claude" {
		t.Fatalf("published CLI %q not in managed store: %v", cli, err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(cli), "..", "package.tgz")); !os.IsNotExist(err) {
		t.Fatalf("tarball left behind: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".cxx", "engines", "escape")); !os.IsNotExist(err) {
		t.Fatalf("archive entry escaped the stage: %v", err)
	}
}

func TestBackgroundClaudeNativeRejectsIntegrityMismatch(t *testing.T) {
	home, bin := stagedInstallFixture(t)
	t.Setenv("PATH", bin)
	nativeRegistry(t, "2.1.2", nativeClaudeTarball(t, "2.1.2"), []byte("expected"))
	err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil)
	if err == nil || !strings.Contains(err.Error(), "integrity") {
		t.Fatalf("tampered tarball accepted: %v", err)
	}
	if got := Version(context.Background()); got != "2.1.1" {
		t.Fatalf("failed install changed published CLI: %q", got)
	}
	entries, _ := os.ReadDir(filepath.Join(home, ".cxx", "engines", "claude"))
	for _, e := range entries {
		if e.IsDir() {
			t.Fatalf("failed stage leaked: %s", e.Name())
		}
	}
}

func TestBackgroundClaudeFallsBackToNativeWhenNpmFails(t *testing.T) {
	_, bin := stagedInstallFixture(t)
	t.Setenv("PATH", bin)
	writeScript(t, filepath.Join(bin, "npm"), "#!/bin/sh\necho 'npm ERR! engine unsupported' >&2\nexit 1\n")
	body := nativeClaudeTarball(t, "2.1.2")
	nativeRegistry(t, "2.1.2", body, body)
	if err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil); err != nil {
		t.Fatalf("native fallback after npm failure: %v", err)
	}
	if got := Version(context.Background()); got != "2.1.2" {
		t.Fatalf("published version = %q", got)
	}
}
