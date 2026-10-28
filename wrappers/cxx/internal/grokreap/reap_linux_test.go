//go:build linux

package grokreap

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// TestMain doubles as the harmless fake leader: a copy of this test binary
// placed in a fake engine store and started as `grok agent leader`.
func TestMain(m *testing.M) {
	if os.Getenv("GROKREAP_FAKE_LEADER") == "1" {
		if os.Getenv("GROKREAP_IGNORE_TERM") == "1" {
			signal.Ignore(syscall.SIGTERM)
		}
		fmt.Println("ready")
		time.Sleep(2 * time.Minute) // bounded even if a test forgets it
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// orphanView is the real /proc with the fake leader shown as reparented to
// init: the test binary's own ancestors (a cxx-launched agent) would
// otherwise, correctly, mark it supervised.
type orphanView struct {
	ProcFS
	pid int
}

func (v orphanView) Process(pid int) (Process, error) {
	p, err := v.ProcFS.Process(pid)
	if err == nil && pid == v.pid {
		p.PPID = 1
	}
	return p, err
}

type shiftedClock struct{ by time.Duration }

func (c shiftedClock) Now() time.Time        { return time.Now().Add(c.by) }
func (c shiftedClock) Sleep(d time.Duration) { time.Sleep(d) }

type realLeader struct {
	cmd               *exec.Cmd
	store, state, dir string
	done              chan struct{}
}

func startFakeLeader(t *testing.T, ignoreTerm bool) *realLeader {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	store := filepath.Join(base, "engines", "grok")
	bin := filepath.Join(store, "1.0.0-test", "grok")
	raw, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(bin), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, raw, 0o700); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(base, "state")
	dir := filepath.Join(state, "runtimes", "session-1")
	if err := os.MkdirAll(filepath.Join(dir, "home"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, privateLeaseName), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "agent", "leader", "--no-exit-on-disconnect")
	cmd.Env = []string{"GROKREAP_FAKE_LEADER=1", "GROK_HOME=" + filepath.Join(dir, "home")}
	if ignoreTerm {
		cmd.Env = append(cmd.Env, "GROKREAP_IGNORE_TERM=1")
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	l := &realLeader{cmd: cmd, store: store, state: state, dir: dir, done: make(chan struct{})}
	if line, err := bufio.NewReader(out).ReadString('\n'); err != nil || line != "ready\n" {
		_ = cmd.Process.Kill()
		t.Fatalf("fake leader not ready: %q %v", line, err)
	}
	go func() { _ = cmd.Wait(); close(l.done) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-l.done })
	return l
}

func (l *realLeader) options(dry bool) Options {
	o := Options{DryRun: dry, StoreDir: l.store, StateDir: l.state, UID: uint32(os.Getuid()), Self: os.Getpid(),
		Proc: orphanView{pid: l.cmd.Process.Pid}, Locks: FlockProbe{}, Signal: PidfdSignaler{},
		Clock: shiftedClock{by: 48 * time.Hour}, TermGrace: 500 * time.Millisecond, KillGrace: 2 * time.Second}
	if dry {
		o.Locks, o.Signal = ProcLocks{}, refuseSignals{}
	}
	return o
}

func (l *realLeader) exited(within time.Duration) bool {
	select {
	case <-l.done:
		return true
	case <-time.After(within):
		return false
	}
}

func TestRealOrphanLeaderIsReaped(t *testing.T) {
	for _, tc := range []struct {
		name       string
		ignoreTerm bool
		reason     string
	}{{"sigterm", false, "sigterm"}, {"escalates to sigkill", true, "sigkill"}} {
		t.Run(tc.name, func(t *testing.T) {
			l := startFakeLeader(t, tc.ignoreTerm)
			r, err := Run(l.options(false))
			if err != nil {
				t.Fatal(err)
			}
			it := find(r, "leader", l.cmd.Process.Pid)
			if it.Action != "reaped" || it.Reason != tc.reason {
				t.Fatalf("leader = %+v (all %+v)", it, r.Items)
			}
			if !l.exited(2 * time.Second) {
				t.Fatal("fake leader still running")
			}
		})
	}
}

func TestRealLeaderWithHeldLeaseSurvives(t *testing.T) {
	l := startFakeLeader(t, false)
	lease, err := os.Open(filepath.Join(l.dir, privateLeaseName))
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if err := syscall.Flock(int(lease.Fd()), syscall.LOCK_SH); err != nil {
		t.Fatal(err)
	}
	for _, dry := range []bool{true, false} {
		r, err := Run(l.options(dry))
		if err != nil {
			t.Fatal(err)
		}
		if it := find(r, "leader", l.cmd.Process.Pid); it.Action != "skipped" || it.Reason != "lease_held" {
			t.Fatalf("dry=%v leader = %+v", dry, it)
		}
	}
	if l.exited(200 * time.Millisecond) {
		t.Fatal("leader with a live lease was signalled")
	}
}

func TestRealDryRunReportsWithoutSignal(t *testing.T) {
	l := startFakeLeader(t, false)
	r, err := Run(l.options(true))
	if err != nil {
		t.Fatal(err)
	}
	if it := find(r, "leader", l.cmd.Process.Pid); it.Action != "would_reap" {
		t.Fatalf("leader = %+v", it)
	}
	if l.exited(200 * time.Millisecond) {
		t.Fatal("dry run signalled")
	}
}

func TestPidfdSignalerRefusesChangedIdentity(t *testing.T) {
	l := startFakeLeader(t, false)
	err := PidfdSignaler{}.Signal(l.cmd.Process.Pid, syscall.SIGTERM, func() error { return ErrIdentityChanged })
	if !errors.Is(err, ErrIdentityChanged) {
		t.Fatalf("err = %v", err)
	}
	if l.exited(200 * time.Millisecond) {
		t.Fatal("signal delivered despite identity mismatch")
	}
}

func TestProcFSIdentityOfSelf(t *testing.T) {
	p, err := ProcFS{}.Process(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if p.UID != uint32(os.Getuid()) || p.PPID != os.Getppid() || p.StartTicks == 0 || len(p.Argv) == 0 {
		t.Fatalf("%+v", p)
	}
	if age := time.Since(p.Start); age < -2*time.Second || age > time.Hour {
		t.Fatalf("start %v implausible (age %v)", p.Start, age)
	}
	if _, err := (ProcFS{}).Process(1 << 30); !errors.Is(err, ErrGone) {
		t.Fatalf("missing pid err = %v", err)
	}
}

func TestFlockProbeNeverCreates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "grok.lock")
	if _, err := (FlockProbe{}).TryExclusive(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatal("probe created the lock file")
	}
	if _, err := (ProcLocks{}).TryExclusive(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("passive probe err = %v", err)
	}
}
