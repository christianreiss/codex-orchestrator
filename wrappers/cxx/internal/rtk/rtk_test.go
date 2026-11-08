package rtk

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

func archive(t *testing.T, name string, kind byte, body string) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tr := tar.NewWriter(gz)
	if err := tr.WriteHeader(&tar.Header{Name: name, Mode: 0700, Typeflag: kind, Size: int64(len(body))}); err != nil {
		t.Fatal(err)
	}
	if kind == tar.TypeReg {
		tr.Write([]byte(body))
	}
	tr.Close()
	gz.Close()
	return b.Bytes()
}
func testPolicy(t *testing.T, raw []byte) (*config.Config, *int) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	calls := new(int)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/wrapper/") {
			*calls++
		}
		if r.Header.Get("X-API-Key") != "fixture-key" {
			t.Error("missing host authentication")
		}
		w.Write(raw)
	}))
	t.Cleanup(srv.Close)
	sum := sha256.Sum256(raw)
	return &config.Config{Engine: "codex", Orchestrator: config.Orchestrator{BaseURL: srv.URL, APIKey: "fixture-key"}, RTK: &config.RTKPolicy{Enabled: true, Protocol: 1, Version: Version, AdapterMode: "instructions", Artifacts: map[string]config.RTKArtifact{runtime.GOOS + "/" + runtime.GOARCH: {URL: srv.URL + "/wrapper/v2/rtk/v1.2.0/fixture", SHA256: hex.EncodeToString(sum[:])}}}}, calls
}
func TestInstallVerifiedCacheAndChangedPolicy(t *testing.T) {
	cfg, calls := testPolicy(t, archive(t, "rtk", tar.TypeReg, "#!/bin/sh\nprintf fixture\n"))
	bin, e := Install(context.Background(), cfg)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = Install(context.Background(), cfg); e != nil {
		t.Fatal(e)
	}
	if *calls != 1 {
		t.Fatalf("cache downloaded %d times", *calls)
	}
	os.WriteFile(bin, []byte("corrupt"), 0700)
	if _, e = Install(context.Background(), cfg); e != nil {
		t.Fatal(e)
	}
	if *calls != 2 {
		t.Fatal("modified binary reused")
	}
	a := cfg.RTK.Artifacts[runtime.GOOS+"/"+runtime.GOARCH]
	a.SHA256 = strings.Repeat("0", 64)
	cfg.RTK.Artifacts[runtime.GOOS+"/"+runtime.GOARCH] = a
	if _, e = Install(context.Background(), cfg); e == nil || e.Error() != "checksum_mismatch" {
		t.Fatalf("changed signed identity reused: %v", e)
	}
}
func TestInstallRefusesLinksAndForeignCredentialTarget(t *testing.T) {
	cfg, _ := testPolicy(t, archive(t, "rtk", tar.TypeSymlink, ""))
	if _, e := Install(context.Background(), cfg); e == nil {
		t.Fatal("symlink accepted")
	}
	a := cfg.RTK.Artifacts[runtime.GOOS+"/"+runtime.GOARCH]
	a.URL = "https://example.invalid/wrapper/v2/rtk/fixture"
	cfg.RTK.Artifacts[runtime.GOOS+"/"+runtime.GOARCH] = a
	if _, e := Install(context.Background(), cfg); e == nil || e.Error() != "invalid_artifact" {
		t.Fatalf("foreign target: %v", e)
	}
}
func TestDisabledDoesNotInstall(t *testing.T) {
	cfg, calls := testPolicy(t, nil)
	cfg.RTK.Enabled = false
	s, e := Prepare(context.Background(), cfg, []string{"--no-rtk", "prompt"}, []string{"PATH=/usr/bin"}, "", io.Discard)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if s.Dir != "" || *calls != 0 || len(s.Args) != 1 || s.Args[0] != "prompt" {
		t.Fatalf("disabled session %#v calls %d", s, *calls)
	}
}
func TestFailedPreparationDoesNotLeakSessionEnvironment(t *testing.T) {
	cfg, _ := testPolicy(t, archive(t, "rtk", tar.TypeReg, "#!/bin/sh\n"))
	cfg.Engine = "future"
	s, e := Prepare(context.Background(), cfg, []string{"prompt"}, []string{"PATH=/usr/bin"}, "", io.Discard)
	if e == nil {
		t.Fatal("future engine accepted")
	}
	if envValue(s.Env, sessionEnv) != "" || len(s.Args) != 1 {
		t.Fatal("failed setup leaked deleted session")
	}
}
func TestSessionRecallLeaseAndInstructions(t *testing.T) {
	cfg, _ := testPolicy(t, archive(t, "rtk", tar.TypeReg, "#!/bin/sh\n"))
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "config.toml"), []byte("developer_instructions = 'Keep my rules'\n"), 0600)
	s, e := Prepare(context.Background(), cfg, []string{"exec", "prompt"}, []string{"PATH=/usr/bin"}, home, io.Discard)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(s.Args[1], "Keep my rules") || !strings.Contains(s.Args[1], "rtk recall") {
		t.Fatal("instruction content lost")
	}
	if envValue(s.Env, "RTK_TELEMETRY_DISABLED") != "1" || envValue(s.Env, "RTK_RECALL_DB") != filepath.Join(s.Dir, "recall.db") {
		t.Fatal("session storage/privacy not projected")
	}
	cmd := exec.Command("sh", "-c", "sleep 1")
	s.Attach(cmd)
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	dir := s.Dir
	s.Close()
	if _, e = os.Stat(dir); e != nil {
		t.Fatal("deleted active native session")
	}
	cmd.Wait()
	s.Close()
	if _, e = os.Stat(dir); !os.IsNotExist(e) {
		t.Fatal("session not cleaned")
	}
}
func fakeSession(t *testing.T, script string) (string, string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	r, _ := root()
	dir := filepath.Join(r, "sessions", "session-fixture")
	os.MkdirAll(dir, 0700)
	bin, _ := binaryPath()
	os.MkdirAll(filepath.Dir(bin), 0700)
	os.WriteFile(bin, []byte("#!/bin/sh\n"+script), 0700)
	t.Setenv(sessionEnv, dir)
	t.Setenv(binaryEnv, bin)
	return dir, bin
}
func TestExecRetainsExitStatus(t *testing.T) {
	fakeSession(t, "printf filtered; printf diagnostic >&2; exit 7\n")
	var out, stderr bytes.Buffer
	if code := Exec(context.Background(), []string{"git", "status"}, strings.NewReader(""), &out, &stderr); code != 7 || out.String() != "filtered" || stderr.String() != "diagnostic" {
		t.Fatalf("exit/output lost: %d %s %s", code, out.String(), stderr.String())
	}
}
func TestRecallRetention(t *testing.T) {
	dir, _ := fakeSession(t, "exit 0\n")
	db, e := sql.Open("sqlite", filepath.Join(dir, "recall.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	_, e = db.Exec("CREATE TABLE recall(hash TEXT,byte_size INTEGER,created_at INTEGER)")
	if e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 20; i++ {
		db.Exec("INSERT INTO recall VALUES(?,?,?)", fmt.Sprint(i), 100, time.Now().Unix()+int64(i))
	}
	db.Exec("INSERT INTO recall VALUES('oversized',?,?)", 11<<20, time.Now().Unix()+100)
	pruneRecall(dir)
	var n int
	db.QueryRow("SELECT COUNT(*) FROM recall").Scan(&n)
	if n != 9 {
		t.Fatalf("unexpected retained rows %d", n)
	}
}

func TestInstructionFlagsPreserveExistingAndDelimiter(t *testing.T) {
	for _, flag := range []string{"--rules", "--append-system-prompt"} {
		got := appendInstructionFlag([]string{flag, "Keep operator rules", "--", "literal"}, flag, "Use RTK")
		if len(got) != 4 || got[1] != "Keep operator rules\n\nUse RTK" {
			t.Fatal(got)
		}
		got = appendInstructionFlag([]string{"--", "literal"}, flag, "Use RTK")
		if len(got) != 4 || got[2] != "--" {
			t.Fatal(got)
		}
	}
}
func TestCodexCLIInstructionOverrideIsPreserved(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "config.toml"), []byte("developer_instructions='From disk'"), 0600)
	got, e := codexInstructions(home, []string{"exec", "-c", "developer_instructions='From CLI'", "prompt"}, "Use RTK")
	if e != nil || len(got) != 4 || !strings.Contains(got[1], "From CLI\\n\\nUse RTK") || strings.Contains(got[1], "From disk") {
		t.Fatal(got, e)
	}
}
func TestPinnedBinaryRecall(t *testing.T) {
	source := os.Getenv("RTK_TEST_BIN")
	if source == "" {
		t.Skip("set RTK_TEST_BIN to verified pinned OSS binary")
	}
	body, e := os.ReadFile(source)
	if e != nil {
		t.Fatal(e)
	}
	cfg, _ := testPolicy(t, archive(t, "rtk", tar.TypeReg, string(body)))
	bin, e := Install(context.Background(), cfg)
	if e != nil {
		t.Fatal(e)
	}
	r, _ := root()
	dir := filepath.Join(r, "sessions", "session-real")
	os.MkdirAll(dir, 0700)
	t.Setenv(sessionEnv, dir)
	t.Setenv(binaryEnv, bin)
	t.Setenv("RTK_RECALL_DB", filepath.Join(dir, "recall.db"))
	t.Setenv("RTK_DB_PATH", filepath.Join(dir, "tracking.db"))
	t.Setenv("RTK_TELEMETRY_DISABLED", "1")
	t.Setenv("RTK_SUPPRESS_HOOK_WARNING", "1")
	fake := t.TempDir()
	script := `#!/bin/sh
printf '%s\n' '{"Action":"run","Package":"fixture","Test":"TestFailure"}' '{"Action":"output","Package":"fixture","Test":"TestFailure","Output":"RTK_FAILURE_EVIDENCE xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n"}' '{"Action":"fail","Package":"fixture","Test":"TestFailure","Elapsed":0.01}' '{"Action":"fail","Package":"fixture","Elapsed":0.01}'
exit 1
`
	os.WriteFile(filepath.Join(fake, "go"), []byte(script), 0700)
	t.Setenv("PATH", fake+string(os.PathListSeparator)+os.Getenv("PATH"))
	var out, stderr bytes.Buffer
	if code := Exec(context.Background(), []string{"go", "test"}, strings.NewReader(""), &out, &stderr); code != 1 {
		t.Fatalf("failure exit lost %d %s %s", code, out.String(), stderr.String())
	}
	if !strings.Contains(out.String()+stderr.String(), "rtk recall") {
		t.Fatalf("missing actual recall hint: %s", out.String())
	}
	db, e := sql.Open("sqlite", filepath.Join(dir, "recall.db"))
	if e != nil {
		t.Fatal(e)
	}
	var hash string
	var size, created int64
	if e = db.QueryRow("SELECT hash,byte_size,created_at FROM recall LIMIT 1").Scan(&hash, &size, &created); e != nil {
		t.Fatal(e)
	}
	if size <= 0 || created < time.Now().Add(-time.Minute).Unix() {
		t.Fatal("pinned recall schema differs")
	}
	db.Close()
	out.Reset()
	if code := Exec(context.Background(), []string{"recall", hash}, strings.NewReader(""), &out, &stderr); code != 0 || !strings.Contains(out.String(), "RTK_FAILURE_EVIDENCE") {
		t.Fatalf("raw recall unavailable %d %s %s", code, out.String(), stderr.String())
	}
}

func TestInstallCachedArtifactDoesNotNeedWriterLock(t *testing.T) {
	cfg, calls := testPolicy(t, archive(t, "rtk", tar.TypeReg, "#!/bin/sh\n"))
	bin, err := Install(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(filepath.Dir(bin), ".install.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	const workers = 8
	results := make(chan error, workers)
	for i := 0; i < workers; i++ {
		go func() { _, err := Install(context.Background(), cfg); results <- err }()
	}
	for i := 0; i < workers; i++ {
		select {
		case err := <-results:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("verified cache blocked on writer")
		}
	}
	if *calls != 1 {
		t.Fatalf("cached engines downloaded %d times", *calls)
	}
}
func TestConcurrentColdInstallSharesVerifiedDownload(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	raw := archive(t, "rtk", tar.TypeReg, "#!/bin/sh\n")
	sum := sha256.Sum256(raw)
	var calls atomic.Int32
	var startedOnce sync.Once
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		startedOnce.Do(func() { close(started) })
		<-release
		w.Write(raw)
	}))
	defer srv.Close()
	defer unblock()
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: srv.URL, APIKey: "fixture"}, RTK: &config.RTKPolicy{Protocol: 1, Version: Version, Artifacts: map[string]config.RTKArtifact{runtime.GOOS + "/" + runtime.GOARCH: {URL: srv.URL + "/wrapper/v2/rtk/v1.2.0/fixture", SHA256: hex.EncodeToString(sum[:])}}}}
	const workers = 8
	results := make(chan error, workers)
	for i := 0; i < workers; i++ {
		go func() { _, err := Install(context.Background(), cfg); results <- err }()
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("download did not start")
	}
	// Contenders must wait for the first response, rather than fail on ErrHeld.
	select {
	case err := <-results:
		unblock()
		t.Fatalf("installer returned before download finished: %v", err)
	case <-time.After(75 * time.Millisecond):
	}
	unblock()
	for i := 0; i < workers; i++ {
		select {
		case err := <-results:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("installer did not observe completed download")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("concurrent engines downloaded %d times", calls.Load())
	}
}
func TestInstallLockWaitHonorsContext(t *testing.T) {
	cfg, calls := testPolicy(t, archive(t, "rtk", tar.TypeReg, "#!/bin/sh\n"))
	bin, _ := binaryPath()
	os.MkdirAll(filepath.Dir(bin), 0700)
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(filepath.Dir(bin), ".install.lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	_, err = Install(ctx, cfg)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock wait ignored context: %v", err)
	}
	if *calls != 0 {
		t.Fatal("download began without writer lease")
	}
}
