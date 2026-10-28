package grokreap

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const uid = 1000

var epoch = time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

// ---- fakes ----

type fakeProc struct {
	procs   map[int]Process
	env     map[int]map[string]string
	envErr  map[int]error
	files   map[int][]string
	fileErr map[int]error
	// onRead lets a test swap identity between scan and verification.
	reads  map[int]int
	onRead func(pid, n int, p *Process) error
}

func (f *fakeProc) PIDs() ([]int, error) {
	var out []int
	for pid := range f.procs {
		out = append(out, pid)
	}
	return out, nil
}
func (f *fakeProc) Process(pid int) (Process, error) {
	p, ok := f.procs[pid]
	if !ok {
		return Process{}, ErrGone
	}
	if f.reads == nil {
		f.reads = map[int]int{}
	}
	f.reads[pid]++
	if f.onRead != nil {
		if err := f.onRead(pid, f.reads[pid], &p); err != nil {
			return Process{}, err
		}
	}
	return p, nil
}
func (f *fakeProc) Environ(pid int) (map[string]string, error) {
	if err := f.envErr[pid]; err != nil {
		return nil, err
	}
	return f.env[pid], nil
}
func (f *fakeProc) OpenFiles(pid int) ([]string, error) {
	if err := f.fileErr[pid]; err != nil {
		return nil, err
	}
	return f.files[pid], nil
}

type fakeLocks struct {
	held   map[string]bool
	failed map[string]bool
	probes []string
}

func (l *fakeLocks) TryExclusive(path string) (func(), error) {
	l.probes = append(l.probes, path)
	if _, err := os.Lstat(path); err != nil {
		return nil, err
	}
	if l.failed[path] {
		return nil, syscall.EIO
	}
	if l.held[path] {
		return nil, ErrHeld
	}
	return func() {}, nil
}

type sent struct {
	pid int
	sig syscall.Signal
}

type fakeSignals struct {
	sent []sent
	// effect runs after a delivered signal (e.g. remove the process).
	effect func(pid int, sig syscall.Signal)
	err    error
}

func (s *fakeSignals) Signal(pid int, sig syscall.Signal, verify func() error) error {
	if err := verify(); err != nil {
		return err
	}
	if s.err != nil {
		return s.err
	}
	s.sent = append(s.sent, sent{pid, sig})
	if s.effect != nil {
		s.effect(pid, sig)
	}
	return nil
}

type fakeClock struct {
	t     time.Time
	slept time.Duration
}

func (c *fakeClock) Now() time.Time { return c.t }
func (c *fakeClock) Sleep(d time.Duration) {
	c.t = c.t.Add(d)
	c.slept += d
}

// ---- fixture ----

type fixture struct {
	t                *testing.T
	store, state     string
	proc             *fakeProc
	locks            *fakeLocks
	sig              *fakeSignals
	clock            *fakeClock
	dry              bool
	maxLeaders, maxL int
}

func newFixture(t *testing.T) *fixture {
	base := t.TempDir()
	f := &fixture{
		t:     t,
		store: filepath.Join(base, "engines", "grok"),
		state: filepath.Join(base, "state"),
		proc:  &fakeProc{procs: map[int]Process{}, env: map[int]map[string]string{}, envErr: map[int]error{}, files: map[int][]string{}, fileErr: map[int]error{}},
		locks: &fakeLocks{held: map[string]bool{}, failed: map[string]bool{}},
		sig:   &fakeSignals{},
		clock: &fakeClock{t: epoch},
	}
	for _, d := range []string{f.store, filepath.Join(f.state, "runtimes"), filepath.Join(f.state, "leader-logs")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// init and a user manager, the parents an orphan is reparented to.
	f.proc.procs[1] = Process{PID: 1, UID: 0, Exe: "/usr/lib/systemd/systemd", Argv: []string{"/sbin/init"}}
	f.proc.procs[2029] = Process{PID: 2029, PPID: 1, UID: uid, Exe: "/usr/lib/systemd/systemd", Argv: []string{"/usr/lib/systemd/systemd", "--user"}}
	return f
}

func (f *fixture) runtime(name string, age time.Duration, lease bool) string {
	dir := filepath.Join(f.state, "runtimes", name)
	if err := os.MkdirAll(filepath.Join(dir, "home"), 0o700); err != nil {
		f.t.Fatal(err)
	}
	files := []string{"grok.lock", "issued.json"}
	if lease {
		files = append(files, privateLeaseName)
	}
	for _, n := range files {
		if err := os.WriteFile(filepath.Join(dir, n), nil, 0o600); err != nil {
			f.t.Fatal(err)
		}
	}
	f.age(dir, age)
	for _, n := range files {
		f.age(filepath.Join(dir, n), age)
	}
	return dir
}

func (f *fixture) age(path string, age time.Duration) {
	at := epoch.Add(-age)
	if err := os.Chtimes(path, at, at); err != nil {
		f.t.Fatal(err)
	}
}

// leader adds an orphaned managed leader bound to dir.
func (f *fixture) leader(pid int, age time.Duration, dir string) {
	exe := filepath.Join(f.store, "1.0.50-1", "grok")
	f.proc.procs[pid] = Process{PID: pid, PPID: 2029, UID: uid, StartTicks: uint64(pid) * 7, Start: epoch.Add(-age), Exe: exe,
		Argv: []string{exe, "agent", "leader", "--no-exit-on-disconnect", "--relay-on-demand"}}
	f.proc.env[pid] = map[string]string{"GROK_HOME": filepath.Join(dir, "home"), "CXX_GROK_SOCKET": filepath.Join(dir, "grok.sock")}
}

func (f *fixture) run() Result {
	f.t.Helper()
	r, err := Run(Options{DryRun: f.dry, StoreDir: f.store, StateDir: f.state, UID: uid, Self: 99999,
		Proc: f.proc, Locks: f.locks, Signal: f.sig, Clock: f.clock, MaxLeaders: f.maxLeaders, MaxLogs: f.maxL})
	if err != nil {
		f.t.Fatal(err)
	}
	return r
}

func find(r Result, kind string, key any) Item {
	for _, it := range r.Items {
		if it.Kind != kind {
			continue
		}
		switch k := key.(type) {
		case int:
			if it.PID == k {
				return it
			}
		case string:
			if it.Path == k || filepath.Base(it.Path) == k {
				return it
			}
		}
	}
	return Item{}
}

// exitOn removes the process when it receives sig.
func (f *fixture) exitOn(sig syscall.Signal) {
	f.sig.effect = func(pid int, got syscall.Signal) {
		if got == sig {
			delete(f.proc.procs, pid)
		}
	}
}

// ---- leaders ----

func TestLeaderRules(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(f *fixture, dir string)
		action string
		reason string
		sigs   int
	}{
		{"orphan reaped by SIGTERM", func(f *fixture, dir string) { f.exitOn(syscall.SIGTERM) }, "reaped", "sigterm", 1},
		{"young leader", func(f *fixture, dir string) {
			p := f.proc.procs[500]
			p.Start = epoch.Add(-23 * time.Hour)
			f.proc.procs[500] = p
		}, "skipped", "young", 0},
		{"lease held by a live wrapper", func(f *fixture, dir string) { f.locks.held[filepath.Join(dir, privateLeaseName)] = true }, "skipped", "lease_held", 0},
		{"lease missing", func(f *fixture, dir string) { _ = os.Remove(filepath.Join(dir, privateLeaseName)) }, "skipped", "lease_missing", 0},
		{"lease probe error", func(f *fixture, dir string) { f.locks.failed[filepath.Join(dir, privateLeaseName)] = true }, "skipped", "lease_probe_failed", 0},
		{"live TUI client attached", func(f *fixture, dir string) {
			f.proc.procs[600] = Process{PID: 600, PPID: 2029, UID: uid, Exe: "/usr/bin/bash", Argv: []string{"bash"}}
			f.proc.env[600] = map[string]string{"GROK_HOME": filepath.Join(dir, "home")}
		}, "skipped", "client_attached", 0},
		{"own MCP child is not a client", func(f *fixture, dir string) {
			f.proc.procs[601] = Process{PID: 601, PPID: 500, UID: uid, Exe: "/usr/local/bin/node", Argv: []string{"node", "mcp.js"}}
			f.proc.env[601] = map[string]string{"GROK_HOME": filepath.Join(dir, "home")}
			f.exitOn(syscall.SIGTERM)
		}, "reaped", "sigterm", 1},
		{"supervised by a live cgx", func(f *fixture, dir string) {
			f.proc.procs[700] = Process{PID: 700, PPID: 2029, UID: uid, Exe: "/usr/local/bin/cxx", Argv: []string{"cgx", "--resume", "x"}}
			p := f.proc.procs[500]
			p.PPID = 700
			f.proc.procs[500] = p
		}, "skipped", "supervised_by_wrapper", 0},
		{"child of a native TUI", func(f *fixture, dir string) {
			exe := filepath.Join(f.store, "1.0.50-1", "grok")
			f.proc.procs[701] = Process{PID: 701, PPID: 2029, UID: uid, Exe: exe, Argv: []string{exe, "--leader"}}
			p := f.proc.procs[500]
			p.PPID = 701
			f.proc.procs[500] = p
		}, "skipped", "attached_native_parent", 0},
		{"environment unreadable", func(f *fixture, dir string) { f.proc.envErr[500] = os.ErrPermission }, "skipped", "environ_unreadable", 0},
		{"no runtime binding", func(f *fixture, dir string) { f.proc.env[500] = map[string]string{"GROK_HOME": "/home/u/.grok"} }, "skipped", "no_runtime_binding", 0},
		{"relevant process with hidden environment", func(f *fixture, dir string) {
			f.proc.procs[602] = Process{PID: 602, PPID: 2029, UID: uid, Argv: []string{"cgx"}}
			f.proc.envErr[602] = os.ErrPermission
		}, "skipped", "client_check_failed", 0},
		{"unrelated non-dumpable process is ignored", func(f *fixture, dir string) {
			f.proc.procs[603] = Process{PID: 603, PPID: 2029, UID: uid, Argv: []string{"/usr/bin/ssh-agent"}}
			f.proc.envErr[603] = os.ErrPermission
			f.exitOn(syscall.SIGTERM)
		}, "reaped", "sigterm", 1},
		{"pid reused before SIGTERM", func(f *fixture, dir string) {
			f.proc.onRead = func(pid, n int, p *Process) error {
				if pid == 500 && n > 1 {
					p.StartTicks++
				}
				return nil
			}
		}, "skipped", "identity_changed", 0},
		{"exited before signal", func(f *fixture, dir string) {
			f.proc.onRead = func(pid, n int, p *Process) error {
				if pid == 500 && n > 1 {
					return ErrGone
				}
				return nil
			}
		}, "reaped", "exited_before_signal", 0},
		{"permission denied", func(f *fixture, dir string) { f.sig.err = syscall.EPERM }, "failed", "sigterm: operation not permitted", 0},
		{"ignores SIGTERM, dies on SIGKILL", func(f *fixture, dir string) { f.exitOn(syscall.SIGKILL) }, "reaped", "sigkill", 2},
		{"survives SIGKILL", func(f *fixture, dir string) {}, "failed", "survived_sigkill", 2},
		{"pid reused during grace is never killed", func(f *fixture, dir string) {
			f.sig.effect = func(pid int, sig syscall.Signal) {
				p := f.proc.procs[pid]
				p.StartTicks = 1 // a new process now owns the PID
				p.Exe = "/usr/bin/vim"
				f.proc.procs[pid] = p
			}
		}, "reaped", "sigterm", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			dir := f.runtime("session-1", 6*24*time.Hour, true)
			f.leader(500, 5*24*time.Hour, dir)
			tc.setup(f, dir)
			r := f.run()
			it := find(r, "leader", 500)
			if it.Action != tc.action || it.Reason != tc.reason {
				t.Fatalf("leader = %s/%s, want %s/%s (%+v)", it.Action, it.Reason, tc.action, tc.reason, r.Items)
			}
			if len(f.sig.sent) != tc.sigs {
				t.Fatalf("signals = %+v, want %d", f.sig.sent, tc.sigs)
			}
			if tc.sigs > 0 && f.sig.sent[0].sig != syscall.SIGTERM {
				t.Fatalf("first signal %v, want SIGTERM", f.sig.sent[0].sig)
			}
			if tc.sigs == 2 && f.sig.sent[1].sig != syscall.SIGKILL {
				t.Fatalf("escalation %v, want SIGKILL", f.sig.sent[1].sig)
			}
		})
	}
}

func TestGraceIsBoundedBeforeKill(t *testing.T) {
	f := newFixture(t)
	dir := f.runtime("session-1", time.Hour, true)
	f.leader(500, 2*24*time.Hour, dir)
	f.exitOn(syscall.SIGKILL)
	f.run()
	if f.clock.slept < LeaderTermGrace || f.clock.slept > LeaderTermGrace+pollInterval {
		t.Fatalf("waited %v before SIGKILL, want %v", f.clock.slept, LeaderTermGrace)
	}
}

func TestOnlyManagedLeadersOfThisUserAreConsidered(t *testing.T) {
	f := newFixture(t)
	dir := f.runtime("session-1", time.Hour, true)
	f.leader(500, 5*24*time.Hour, dir)
	f.exitOn(syscall.SIGTERM)
	// Same argv, binary outside the managed store.
	f.proc.procs[510] = Process{PID: 510, PPID: 2029, UID: uid, Start: epoch.Add(-9 * 24 * time.Hour), Exe: "/opt/grok/grok", Argv: []string{"/opt/grok/grok", "agent", "leader"}}
	// Managed binary, another user.
	other := f.proc.procs[500]
	other.PID, other.UID = 511, 1001
	f.proc.procs[511] = other
	// Managed binary, not a leader.
	tui := f.proc.procs[500]
	tui.PID, tui.Argv = 512, []string{tui.Exe, "--leader-socket", "x"}
	f.proc.procs[512] = tui
	// A path that only looks like the store.
	fake := f.proc.procs[500]
	fake.PID, fake.Exe = 513, f.store+"-evil/grok"
	f.proc.procs[513] = fake
	r := f.run()
	for _, pid := range []int{510, 511, 512, 513} {
		if it := find(r, "leader", pid); it.Kind != "" {
			t.Fatalf("pid %d inspected as managed leader: %+v", pid, it)
		}
	}
	if len(f.sig.sent) != 1 || f.sig.sent[0].pid != 500 {
		t.Fatalf("signals %+v", f.sig.sent)
	}
}

func TestDryRunNeverSignalsOrRemoves(t *testing.T) {
	f := newFixture(t)
	f.dry = true
	dir := f.runtime("session-1", 30*24*time.Hour, true)
	f.leader(500, 5*24*time.Hour, f.runtime("session-2", time.Hour, true))
	log := filepath.Join(f.state, "leader-logs", "grok-1.log")
	_ = os.WriteFile(log, nil, 0o600)
	f.age(log, 30*24*time.Hour)
	r := f.run()
	if len(f.sig.sent) != 0 {
		t.Fatalf("dry run signalled %+v", f.sig.sent)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatal("dry run removed runtime")
	}
	if _, err := os.Stat(log); err != nil {
		t.Fatal("dry run removed log")
	}
	if got := r.Summary(); got != "reaper grok (dry-run): would reap 1 leader(s), 1 runtime dir(s), 1 leader log(s)" {
		t.Fatalf("summary %q", got)
	}
}

func TestLeaderBatchLimit(t *testing.T) {
	f := newFixture(t)
	f.maxLeaders = 1
	f.exitOn(syscall.SIGTERM)
	f.leader(500, 5*24*time.Hour, f.runtime("session-1", time.Hour, true))
	f.leader(501, 5*24*time.Hour, f.runtime("session-2", time.Hour, true))
	r := f.run()
	if find(r, "leader", 500).Action != "reaped" || find(r, "leader", 501).Reason != "batch_limit" {
		t.Fatalf("%+v", r.Items)
	}
}

// ---- runtimes ----

func TestRuntimeRules(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(f *fixture, dir string)
		action string
		reason string
	}{
		{"dead locks removed", func(f *fixture, dir string) {}, "removed", ""},
		{"legacy dir without lease", func(f *fixture, dir string) {
			_ = os.Remove(filepath.Join(dir, privateLeaseName))
			f.age(dir, 8*24*time.Hour)
		}, "removed", ""},
		{"young", func(f *fixture, dir string) { f.age(filepath.Join(dir, "issued.json"), time.Hour) }, "skipped", "young"},
		{"native lock held", func(f *fixture, dir string) { f.locks.held[filepath.Join(dir, "grok.lock")] = true }, "skipped", "grok_lock_held"},
		{"private lease held", func(f *fixture, dir string) { f.locks.held[filepath.Join(dir, privateLeaseName)] = true }, "skipped", "lease_held"},
		{"lock probe error", func(f *fixture, dir string) { f.locks.failed[filepath.Join(dir, "grok.lock")] = true }, "skipped", "lock_probe_failed"},
		{"environment bound", func(f *fixture, dir string) {
			f.proc.procs[600] = Process{PID: 600, PPID: 1, UID: uid, Argv: []string{"sh"}}
			f.proc.env[600] = map[string]string{"GROK_AUTH_PATH": filepath.Join(dir, "home", "auth.json")}
		}, "skipped", "in_use"},
		{"file held open", func(f *fixture, dir string) {
			f.proc.procs[600] = Process{PID: 600, PPID: 1, UID: uid, Argv: []string{"tail"}}
			f.proc.files[600] = []string{filepath.Join(dir, "home", "leader.log")}
		}, "skipped", "open_files"},
		{"unknown holder", func(f *fixture, dir string) {
			f.proc.procs[600] = Process{PID: 600, PPID: 1, UID: uid, Argv: []string{"grok"}}
			f.proc.fileErr[600] = os.ErrPermission
		}, "skipped", "in_use_check_failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			dir := f.runtime("session-9", 8*24*time.Hour, true)
			tc.setup(f, dir)
			r := f.run()
			it := find(r, "runtime", dir)
			if it.Action != tc.action || it.Reason != tc.reason {
				t.Fatalf("runtime = %s/%s, want %s/%s", it.Action, it.Reason, tc.action, tc.reason)
			}
			_, err := os.Stat(dir)
			if (tc.action == "removed") != os.IsNotExist(err) {
				t.Fatalf("dir present=%v after %s", err == nil, tc.action)
			}
		})
	}
}

func TestRuntimeRemovalDoesNotFollowHomeLinks(t *testing.T) {
	f := newFixture(t)
	shared := filepath.Join(t.TempDir(), "sessions")
	if err := os.MkdirAll(shared, 0o700); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(shared, "events.jsonl")
	_ = os.WriteFile(keep, []byte("x"), 0o600)
	dir := f.runtime("session-9", 8*24*time.Hour, true)
	if err := os.Symlink(shared, filepath.Join(dir, "home", "sessions")); err != nil {
		t.Fatal(err)
	}
	f.age(dir, 8*24*time.Hour)
	if it := find(f.run(), "runtime", dir); it.Action != "removed" {
		t.Fatalf("%+v", it)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("shared native session lost: %v", err)
	}
}

func TestRuntimePartialFailureContinues(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	f := newFixture(t)
	bad := f.runtime("session-1", 8*24*time.Hour, true)
	good := f.runtime("session-2", 8*24*time.Hour, true)
	locked := filepath.Join(bad, "home", "ro")
	_ = os.MkdirAll(locked, 0o700)
	_ = os.WriteFile(filepath.Join(locked, "f"), nil, 0o600)
	_ = os.Chmod(locked, 0o500)
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })
	f.age(bad, 8*24*time.Hour)
	r := f.run()
	if it := find(r, "runtime", bad); it.Action != "failed" {
		t.Fatalf("bad = %+v", it)
	}
	if it := find(r, "runtime", good); it.Action != "removed" {
		t.Fatalf("good = %+v", it)
	}
	if s := r.Summary(); !strings.Contains(s, "1 runtime dir(s)") || !strings.Contains(s, "failed 1 runtime permission denied") {
		t.Fatalf("summary %q", s)
	}
}

func TestForeignAndSymlinkedRuntimeEntriesIgnored(t *testing.T) {
	f := newFixture(t)
	target := f.runtime("session-real", 8*24*time.Hour, true)
	link := filepath.Join(f.state, "runtimes", "session-link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(f.state, "runtimes", "other-1")
	_ = os.MkdirAll(other, 0o700)
	f.age(other, 30*24*time.Hour)
	r := f.run()
	if find(r, "runtime", link).Kind != "" || find(r, "runtime", other).Kind != "" {
		t.Fatalf("%+v", r.Items)
	}
	if _, err := os.Lstat(other); err != nil {
		t.Fatal("non-session entry removed")
	}
}

// ---- logs ----

func TestLeaderLogRetention(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.state, "leader-logs")
	mk := func(name string, size int, age time.Duration) string {
		p := filepath.Join(dir, name)
		_ = os.WriteFile(p, make([]byte, size), 0o600)
		f.age(p, age)
		return p
	}
	emptyOld := mk("grok-1.log", 0, 4*24*time.Hour)
	emptyYoung := mk("grok-2.log", 0, 2*24*time.Hour)
	fullMid := mk("grok-3.log", 10, 5*24*time.Hour)
	fullOld := mk("grok-4.log", 10, 15*24*time.Hour)
	openOld := mk("grok-5.log", 0, 20*24*time.Hour)
	other := mk("notes.txt", 0, 90*24*time.Hour)
	f.proc.procs[600] = Process{PID: 600, PPID: 1, UID: uid, Argv: []string{"cxx"}}
	f.proc.files[600] = []string{openOld}
	r := f.run()
	want := map[string]string{emptyOld: "removed", emptyYoung: "skipped", fullMid: "skipped", fullOld: "removed", openOld: "skipped"}
	for p, action := range want {
		if it := find(r, "log", p); it.Action != action {
			t.Fatalf("%s = %+v, want %s", filepath.Base(p), it, action)
		}
	}
	if find(r, "log", openOld).Reason != "open" {
		t.Fatal("open log not protected")
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("unrelated file removed")
	}
	if got := r.Summary(); got != "reaper grok: reaped 0 leader(s), 0 runtime dir(s), 2 leader log(s); skipped 1 log open" {
		t.Fatalf("summary %q", got)
	}
}

func TestLogBatchLimit(t *testing.T) {
	f := newFixture(t)
	f.maxL = 2
	for i := 0; i < 5; i++ {
		p := filepath.Join(f.state, "leader-logs", "grok-"+string(rune('a'+i))+".log")
		_ = os.WriteFile(p, nil, 0o600)
		f.age(p, 10*24*time.Hour)
	}
	r := f.run()
	_, _, logs := r.Pending()
	if logs != 2 {
		t.Fatalf("removed %d logs, want batch of 2", logs)
	}
	entries, _ := os.ReadDir(filepath.Join(f.state, "leader-logs"))
	if len(entries) != 3 {
		t.Fatalf("%d logs left", len(entries))
	}
}

func TestSummaryNamesEveryNonTrivialSkip(t *testing.T) {
	r := Result{Items: []Item{
		{Kind: "leader", Action: "reaped"},
		{Kind: "leader", Action: "skipped", Reason: "lease_held"},
		{Kind: "leader", Action: "skipped", Reason: "young"},
		{Kind: "runtime", Action: "skipped", Reason: "young"},
		{Kind: "log", Action: "skipped", Reason: "young"},
		{Kind: "runtime", Action: "skipped", Reason: "grok_lock_held"},
		{Kind: "runtime", Action: "failed", Reason: "permission denied"},
	}, Errors: []string{"leader-logs: permission denied"}}
	want := "reaper grok: reaped 1 leader(s), 0 runtime dir(s), 0 leader log(s); skipped 1 leader lease_held, 1 leader young, 1 runtime grok_lock_held; failed 1 runtime permission denied; errors: leader-logs: permission denied"
	if got := r.Summary(); got != want {
		t.Fatalf("summary\n got %q\nwant %q", got, want)
	}
}

func TestMisconfiguredRefuses(t *testing.T) {
	if _, err := Run(Options{}); err == nil || !strings.Contains(err.Error(), "misconfigured") {
		t.Fatalf("err = %v", err)
	}
	if err := (refuseSignals{}).Signal(1, syscall.SIGTERM, func() error { return nil }); err == nil || errors.Is(err, ErrGone) {
		t.Fatal("dry-run signaler must refuse")
	}
}
