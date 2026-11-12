package claude

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/libcselect"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
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
	writeScript(t, filepath.Join(bin, "npm"), "#!/bin/sh\nif [ \"$1 $2 $3\" = \"config get cache\" ]; then echo \"$HOME/.npm\"; exit 0; fi\necho 'npm ERR! engine unsupported' >&2\nexit 1\n")
	body := nativeClaudeTarball(t, "2.1.2")
	nativeRegistry(t, "2.1.2", body, body)
	if err := EnsureClaudeBackground(context.Background(), "2.1.2", true, nil); err != nil {
		t.Fatalf("native fallback after npm failure: %v", err)
	}
	if got := Version(context.Background()); got != "2.1.2" {
		t.Fatalf("published version = %q", got)
	}
}

func TestClaudeSameVersionMUSLFallbackThenGNU(t *testing.T) {
	_, bin := stagedInstallFixture(t)
	t.Setenv("PATH", bin)
	body := nativeClaudeTarball(t, "2.1.2")
	sum := sha512.Sum512(body)
	var gnu atomic.Bool
	var archives atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/native.tgz" {
			archives.Add(1)
			_, _ = w.Write(body)
			return
		}
		if !strings.Contains(r.URL.Path, "-musl/") && !gnu.Load() {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"dist": map[string]any{"tarball": "http://" + r.Host + "/native.tgz", "integrity": "sha512-" + base64.StdEncoding.EncodeToString(sum[:]), "unpackedSize": len(body)}})
	}))
	defer srv.Close()
	t.Setenv("npm_config_registry", srv.URL)
	ctx := libcselect.WithHost(context.Background(), libcselect.Host{GNU: true, Fingerprint: "gnu"})
	if e := EnsureClaudeBackground(ctx, "2.1.2", true, nil); e != nil {
		t.Fatal(e)
	}
	musl, _ := FindCLI()
	root, _ := managedClaudeRoot()
	if libcselect.Status(root).Variant != libcselect.Musl {
		t.Fatal("missing GNU did not fall back")
	}
	if e := EnsureClaudeBackground(ctx, "2.1.2", true, nil); e != nil {
		t.Fatal(e)
	}
	if archives.Load() != 1 {
		t.Fatal("fallback redownload loop")
	}
	gnu.Store(true)
	if e := EnsureClaudeBackground(libcselect.Force(ctx), "2.1.2", true, nil); e != nil {
		t.Fatal(e)
	}
	selected, _ := FindCLI()
	if selected == musl || libcselect.Status(root).Variant != libcselect.GNU {
		t.Fatal("same-version glibc migration skipped")
	}
	for range 3 {
		if e := EnsureClaudeBackground(ctx, "2.1.2", true, nil); e != nil {
			t.Fatal(e)
		}
	}
	if archives.Load() != 2 {
		t.Fatal("converged glibc downloaded again")
	}
}
func TestClaudeNpmIntegrityFailureDoesNotTryAnotherVariant(t *testing.T) {
	_, bin := stagedInstallFixture(t)
	marker := filepath.Join(t.TempDir(), "npm-called")
	writeScript(t, filepath.Join(bin, "npm"), "#!/bin/sh\nif [ \"$1 $2 $3\" = 'config get cache' ]; then echo \"$HOME/.npm\"; exit 0; fi\necho called >> '"+marker+"'\necho 'npm ERR! EINTEGRITY' >&2\nexit 1\n")
	ctx := libcselect.WithHost(context.Background(), libcselect.Host{GNU: true, Fingerprint: "gnu"})
	if e := EnsureClaudeBackground(ctx, "2.1.2", true, nil); !errors.Is(e, libcselect.ErrIntegrity) {
		t.Fatal(e)
	}
	calls, _ := os.ReadFile(marker)
	if string(calls) != "called\n" {
		t.Fatal("integrity failure attempted musl", string(calls))
	}
}

func TestClaudeEarlierNpmIncompatibilityDoesNotMaskNativeFailure(t *testing.T) {
	for _, failure := range []string{"integrity", "transient"} {
		t.Run(failure, func(t *testing.T) {
			_, bin := stagedInstallFixture(t)
			script := `#!/bin/sh
if [ "$1 $2 $3" = 'config get cache' ]; then echo "$HOME/.npm"; exit 0; fi
stage="$3"
mkdir -p "$stage/node_modules/.bin"
cat > "$stage/node_modules/.bin/claude" <<'CLI'
#!/bin/sh
if test -e "$0.probed"; then
 echo 'error while loading shared libraries: libc.so.6: cannot open shared object file' >&2
 exit 1
fi
: > "$0.probed"
echo '2.1.2 (Claude Code)'
CLI
chmod +x "$stage/node_modules/.bin/claude"
`
			writeScript(t, filepath.Join(bin, "npm"), script)
			var musl atomic.Int32
			sum := sha512.Sum512([]byte("expected"))
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "-musl/") {
					musl.Add(1)
				}
				if failure == "transient" {
					http.Error(w, "temporary", http.StatusServiceUnavailable)
					return
				}
				if r.URL.Path == "/pkg.tgz" {
					_, _ = w.Write([]byte("tampered"))
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"dist": map[string]any{"tarball": "http://" + r.Host + "/pkg.tgz", "integrity": "sha512-" + base64.StdEncoding.EncodeToString(sum[:])}})
			}))
			defer srv.Close()
			t.Setenv("npm_config_registry", srv.URL)
			ctx := libcselect.WithHost(context.Background(), libcselect.Host{GNU: true, Fingerprint: "gnu"})
			err := EnsureClaudeBackground(ctx, "2.1.2", true, nil)
			if err == nil || libcselect.MayFallback(err) {
				t.Fatalf("native failure inherited npm fallback classification: %v", err)
			}
			if !strings.Contains(err.Error(), "error while loading shared libraries") {
				t.Fatalf("npm incompatibility was not exercised: %v", err)
			}
			if musl.Load() != 0 {
				t.Fatalf("native failure attempted musl %d times: %v", musl.Load(), err)
			}
			if got := Version(context.Background()); got != "2.1.1" {
				t.Fatalf("failed install published %q", got)
			}
		})
	}
}
