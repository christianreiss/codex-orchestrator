package libcselect

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type fixture struct {
	root, path, version string
	ctx                 context.Context
	calls               []string
	failure             error
	unavailable         bool
	publishLost         bool
}

func setup(t *testing.T) *fixture {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("Linux libc policy")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	f := &fixture{root: filepath.Join(home, ".cxx", "engines", "test"), version: "1.2.3", ctx: WithHost(context.Background(), Host{true, "host-a"})}
	if e := os.MkdirAll(f.root, 0700); e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *fixture) current() (string, string) {
	if f.path == "" {
		return "", ""
	}
	return f.path, f.version
}
func (f *fixture) install(ctx context.Context) error {
	variant := Requested(ctx)
	f.calls = append(f.calls, variant)
	if variant == GNU && f.unavailable {
		return ErrUnavailable
	}
	if f.failure != nil {
		return f.failure
	}
	stage, e := os.MkdirTemp(f.root, "stage-")
	if e != nil {
		return e
	}
	path := filepath.Join(stage, "cli")
	if e = os.WriteFile(path, []byte("#!/bin/sh\necho 1.2.3\n"), 0700); e != nil {
		return e
	}
	if e = Publication(ctx, path, "provider-"+variant+"-digest"); e != nil {
		return e
	}
	f.path = path
	if f.publishLost {
		return errors.New("publication completion lost")
	}
	return nil
}
func (f *fixture) run(ctx context.Context) error {
	return Run(ctx, f.root, f.version, f.current, f.install, nil)
}
func (f *fixture) expire(t *testing.T) {
	t.Helper()
	s := Status(f.root)
	s.NextCheck = time.Now().Add(-time.Second)
	if e := write(filepath.Join(f.root, stateName), s); e != nil {
		t.Fatal(e)
	}
}
func TestSameVersionFallbackThenGNUWithoutLoops(t *testing.T) {
	f := setup(t)
	f.unavailable = true
	if e := f.run(f.ctx); e != nil {
		t.Fatal(e)
	}
	musl := f.path
	if strings.Join(f.calls, ",") != "glibc,musl" {
		t.Fatal(f.calls)
	}
	s := Status(f.root)
	if s.Variant != Musl || s.Reason == "" || time.Until(s.NextCheck) < 23*time.Hour {
		t.Fatalf("%+v", s)
	}
	for range 4 {
		if e := f.run(f.ctx); e != nil {
			t.Fatal(e)
		}
	}
	if len(f.calls) != 2 {
		t.Fatal("fallback retried before deadline", f.calls)
	}
	f.expire(t)
	if e := f.run(f.ctx); e != nil {
		t.Fatal(e)
	}
	if f.path != musl || strings.Join(f.calls, ",") != "glibc,musl,glibc" {
		t.Fatal("fallback downloaded again", f.calls)
	}
	f.unavailable = false
	f.expire(t)
	if e := f.run(f.ctx); e != nil {
		t.Fatal(e)
	}
	if f.path == musl || Status(f.root).Variant != GNU {
		t.Fatal("same-version musl did not migrate")
	}
	calls := len(f.calls)
	for range 4 {
		if e := f.run(f.ctx); e != nil {
			t.Fatal(e)
		}
	}
	if len(f.calls) != calls {
		t.Fatal("converged GNU reinstalled")
	}
	if _, e := os.Stat(musl); e != nil {
		t.Fatal("old session's prefix removed", e)
	}
}
func TestFailuresBackOffPersistentlyAndForceOnce(t *testing.T) {
	f := setup(t)
	f.failure = errors.New("checksum mismatch")
	if e := f.run(f.ctx); e == nil {
		t.Fatal("failure swallowed")
	}
	if len(f.calls) != 1 || f.calls[0] != GNU {
		t.Fatal("integrity failure fell back", f.calls)
	}
	s := Status(f.root)
	if s.Failures != 1 || time.Until(s.NextCheck) < 14*time.Minute {
		t.Fatalf("%+v", s)
	}
	if e := f.run(f.ctx); e == nil || !strings.Contains(e.Error(), "deferred") {
		t.Fatal(e)
	}
	if len(f.calls) != 1 {
		t.Fatal("empty bootstrap pointer disabled backoff")
	}
	if e := f.run(Force(f.ctx)); e == nil {
		t.Fatal("failure swallowed")
	}
	s = Status(f.root)
	if s.Failures != 2 || time.Until(s.NextCheck) < 59*time.Minute {
		t.Fatalf("%+v", s)
	}
	f.expire(t)
	_ = f.run(f.ctx)
	s = Status(f.root)
	if s.Failures != 3 || time.Until(s.NextCheck) < 5*time.Hour {
		t.Fatalf("%+v", s)
	}
	f.failure = nil
	f.version = "1.2.4"
	// The provider version callback is the adapter's responsibility; this fake
	// returns the new pinned version and demonstrates bypass of the old key.
	if e := f.run(f.ctx); e != nil {
		t.Fatal("new version inherited old backoff", e)
	}
}
func TestLoaderIncompatibilityFallsBackButUnknownErrorDoesNot(t *testing.T) {
	for _, err := range []error{ErrUnavailable, Incompatible(errors.New("glibc too old")), errors.New("timeout"), errors.New("checksum mismatch")} {
		if got := MayFallback(err); got != (errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "too old")) {
			t.Fatalf("%v: %v", err, got)
		}
	}
}
func TestPublicationReceiptRecoversLostCompletion(t *testing.T) {
	f := setup(t)
	f.publishLost = true
	if e := f.run(f.ctx); e == nil {
		t.Fatal("lost completion not reported")
	}
	selected := f.path
	f.publishLost = false
	if e := f.run(f.ctx); e != nil {
		t.Fatal(e)
	}
	if f.path != selected || len(f.calls) != 1 || Status(f.root).Failed {
		t.Fatal("already-published GNU reinstalled", Status(f.root))
	}
}
func TestChangedHostRechecksAndMUSLHostDoesNotAttemptGNU(t *testing.T) {
	f := setup(t)
	f.ctx = WithHost(f.ctx, Host{false, "musl-host"})
	if e := f.run(f.ctx); e != nil {
		t.Fatal(e)
	}
	if strings.Join(f.calls, ",") != Musl {
		t.Fatal(f.calls)
	}
	f.ctx = WithHost(f.ctx, Host{true, "gnu-host"})
	if e := f.run(f.ctx); e != nil {
		t.Fatal(e)
	}
	if strings.Join(f.calls, ",") != "musl,glibc" {
		t.Fatal(f.calls)
	}
}
func TestConcurrentReconciliationPublishesOnce(t *testing.T) {
	f := setup(t)
	ctx, cancel := context.WithTimeout(f.ctx, 3*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- f.run(ctx) }()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	if len(f.calls) != 1 {
		t.Fatal("concurrent attempts reinstalled", f.calls)
	}
}
func TestChangedExecutableInvalidatesReceipt(t *testing.T) {
	f := setup(t)
	if e := f.run(f.ctx); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(f.path, []byte("#!/bin/sh\necho different\n"), 0700); e != nil {
		t.Fatal(e)
	}
	if e := f.run(f.ctx); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) != 2 {
		t.Fatal("stale file identity trusted")
	}
}
func TestProbeClassifiesOnlyLoaderFailures(t *testing.T) {
	if e := os.MkdirAll(t.TempDir(), 0700); e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		body     string
		fallback bool
	}{
		{"echo 'error while loading shared libraries: libfoo.so: cannot open shared object file' >&2; exit 127", true},
		{"echo \"version 'GLIBC_2.99' not found\" >&2; exit 1", true},
		{"echo 'provider internal failure' >&2; exit 1", false},
	} {
		p := filepath.Join(t.TempDir(), "probe")
		if e := os.WriteFile(p, []byte("#!/bin/sh\n"+tc.body), 0700); e != nil {
			t.Fatal(e)
		}
		_, e := Probe(context.Background(), p, "--version")
		if e == nil || MayFallback(e) != tc.fallback {
			t.Fatalf("%s: %v", tc.body, e)
		}
	}
}

func TestSuccessfulCallbackMustPublishItsOwnReceipt(t *testing.T) {
	f := setup(t)
	e := Run(f.ctx, f.root, f.version, f.current, func(context.Context) error { return nil }, nil)
	if e == nil || !strings.Contains(e.Error(), "did not converge") {
		t.Fatal("no-op callback accepted as successful installation", e)
	}
}
func TestHealthFailureRepairsSameVersionSibling(t *testing.T) {
	f := setup(t)
	healthy := true
	ctx := WithHealth(f.ctx, func(string) bool { return healthy })
	if e := f.run(ctx); e != nil {
		t.Fatal(e)
	}
	healthy = false
	repair := func(ctx context.Context) error { e := f.install(ctx); healthy = true; return e }
	if e := Run(ctx, f.root, f.version, f.current, repair, nil); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) != 2 {
		t.Fatal("healthy main executable hid missing sibling")
	}
}
func TestAliasResolutionBackoffAndSuccessRefresh(t *testing.T) {
	f := setup(t)
	resolves := 0
	failing := true
	ctx := WithResolver(f.ctx, func(context.Context) (string, error) {
		resolves++
		if failing {
			return "", errors.New("metadata timeout")
		}
		return f.version, nil
	})
	call := func() error { return Run(ctx, f.root, "latest", f.current, f.install, nil) }
	if e := call(); e == nil {
		t.Fatal("metadata error swallowed")
	}
	for range 3 {
		if e := call(); e == nil {
			t.Fatal("metadata failure hidden")
		}
	}
	if resolves != 1 {
		t.Fatal("preliminary metadata resolution looped", resolves)
	}
	failing = false
	f.expire(t)
	if e := call(); e != nil {
		t.Fatal(e)
	}
	if Status(f.root).Request != "latest" || Status(f.root).Version != f.version || Status(f.root).NextCheck.IsZero() {
		t.Fatal("resolved alias not recorded", Status(f.root))
	}
	for range 3 {
		if e := call(); e != nil {
			t.Fatal(e)
		}
	}
	if resolves != 2 || len(f.calls) != 1 {
		t.Fatal("stable latest selection looped", resolves, f.calls)
	}
	f.expire(t)
	if e := call(); e != nil {
		t.Fatal(e)
	}
	if resolves != 3 || len(f.calls) != 1 {
		t.Fatal("alias refresh reinstalled identical artifact")
	}
}

func TestMalformedFailureDeadlineCannotPostponeForever(t *testing.T) {
	f := setup(t)
	f.failure = errors.New("network failure")
	_ = f.run(f.ctx)
	s := Status(f.root)
	s.NextCheck = time.Time{}
	if e := write(filepath.Join(f.root, stateName), s); e != nil {
		t.Fatal(e)
	}
	_ = f.run(f.ctx)
	if len(f.calls) != 2 {
		t.Fatal("zero failure deadline became permanent")
	}
	s = Status(f.root)
	s.NextCheck = time.Now().Add(365 * 24 * time.Hour)
	if e := write(filepath.Join(f.root, stateName), s); e != nil {
		t.Fatal(e)
	}
	_ = f.run(f.ctx)
	if len(f.calls) != 3 {
		t.Fatal("implausible future deadline became permanent")
	}
}
