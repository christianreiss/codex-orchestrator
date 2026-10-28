// Package grokreap removes cgx leftovers that no live session can use: orphaned
// native Grok leaders, stale private runtime directories and old leader logs.
//
// Native Grok can spawn its own detached `agent leader --no-exit-on-disconnect`
// from inside a cgx-launched TUI. That leader inherits the private GROK_HOME
// but not the wrapper's lifetime: when cgx exits it is reparented to init, its
// auth socket is gone and every credential refresh fails, yet it keeps the
// runtime directory, the engine version and the housekeeping process scan busy
// forever. Everything here is fail-closed: any check that cannot be proven
// leaves the item alone and names the reason.
package grokreap

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// Thresholds. A leftover must be older than these before it is touched; the
// other checks (lease, lock, environment, open files) must pass as well.
const (
	LeaderOrphanAge  = 24 * time.Hour
	LeaderTermGrace  = 10 * time.Second
	LeaderKillGrace  = 3 * time.Second
	RuntimeStaleAge  = 7 * 24 * time.Hour
	EmptyLogStaleAge = 3 * 24 * time.Hour
	LogStaleAge      = 14 * 24 * time.Hour

	MaxLeadersPerRun  = 8
	MaxRuntimesPerRun = 32
	MaxLogsPerRun     = 256

	pollInterval = 100 * time.Millisecond
)

const privateLeaseName = ".cxx-private-lease"

var (
	// ErrGone means the process no longer exists (or is a zombie).
	ErrGone = errors.New("process gone")
	// ErrIdentityChanged means the PID now names a different process.
	ErrIdentityChanged = errors.New("process identity changed")
	// ErrHeld means another open file description holds the lock.
	ErrHeld = errors.New("lock held")
	// ErrUnsupported is returned where /proc is unavailable.
	ErrUnsupported = errors.New("orphan reaping requires Linux /proc")
)

// Process is the identity of one process. PID plus StartTicks is unique for
// the life of the system; Exe and Argv are compared as well before a signal.
type Process struct {
	PID, PPID  int
	UID        uint32
	StartTicks uint64
	Start      time.Time
	Exe        string // resolved /proc/<pid>/exe, " (deleted)" suffix removed
	Argv       []string
}

// Proc reads process state. The Linux implementation reads /proc.
type Proc interface {
	PIDs() ([]int, error)
	// Process returns ErrGone for a missing or zombie process.
	Process(pid int) (Process, error)
	Environ(pid int) (map[string]string, error)
	OpenFiles(pid int) ([]string, error)
}

// Locks probes flock(2) leases without creating files.
type Locks interface {
	// TryExclusive returns ErrHeld when another holder has the lock and
	// os.ErrNotExist when path is missing. release drops the probe.
	TryExclusive(path string) (release func(), err error)
}

// Signaler delivers sig to pid. It must call verify after pinning the process
// (pidfd) and immediately before signalling, and must not signal on error.
type Signaler interface {
	Signal(pid int, sig syscall.Signal, verify func() error) error
}

// Clock is injected so grace periods are testable.
type Clock interface {
	Now() time.Time
	Sleep(time.Duration)
}

// refuseSignals backs dry runs: a bug that reached it would fail, not kill.
type refuseSignals struct{}

func (refuseSignals) Signal(int, syscall.Signal, func() error) error {
	return errors.New("dry run never signals")
}

type realClock struct{}

func (realClock) Now() time.Time        { return time.Now() }
func (realClock) Sleep(d time.Duration) { time.Sleep(d) }

type Options struct {
	DryRun   bool
	StoreDir string // ~/.cxx/engines/grok: managed native binaries
	StateDir string // ~/.cgx/state
	UID      uint32
	Self     int
	Proc     Proc
	Locks    Locks
	Signal   Signaler
	Clock    Clock

	// Zero means the package constant.
	LeaderAge, RuntimeAge, EmptyLogAge, LogAge, TermGrace, KillGrace time.Duration
	MaxLeaders, MaxRuntimes, MaxLogs                                 int
}

// Item is one inspected leftover and what happened to it.
type Item struct {
	Kind   string        `json:"kind"` // leader | runtime | log
	PID    int           `json:"pid,omitempty"`
	Path   string        `json:"path,omitempty"`
	Age    time.Duration `json:"age_ns"`
	Action string        `json:"action"` // reaped | would_reap | removed | would_remove | skipped | failed
	Reason string        `json:"reason,omitempty"`
}

type Result struct {
	DryRun bool     `json:"dry_run"`
	Items  []Item   `json:"items"`
	Errors []string `json:"errors,omitempty"`
}

func (o *Options) defaults() {
	if o.Clock == nil {
		o.Clock = realClock{}
	}
	def := func(v *time.Duration, d time.Duration) {
		if *v == 0 {
			*v = d
		}
	}
	def(&o.LeaderAge, LeaderOrphanAge)
	def(&o.RuntimeAge, RuntimeStaleAge)
	def(&o.EmptyLogAge, EmptyLogStaleAge)
	def(&o.LogAge, LogStaleAge)
	def(&o.TermGrace, LeaderTermGrace)
	def(&o.KillGrace, LeaderKillGrace)
	if o.MaxLeaders == 0 {
		o.MaxLeaders = MaxLeadersPerRun
	}
	if o.MaxRuntimes == 0 {
		o.MaxRuntimes = MaxRuntimesPerRun
	}
	if o.MaxLogs == 0 {
		o.MaxLogs = MaxLogsPerRun
	}
}

type scan struct {
	o       Options
	now     time.Time
	procs   map[int]Process // readable processes of this UID
	all     map[int]Process // every readable process (ancestor walk)
	env     map[int]map[string]string
	open    map[string]bool // paths held open by any process of this UID
	openErr error
}

// Run inspects and (unless DryRun) reaps. Leaders go first: an orphan pins its
// runtime directory through GROK_HOME and its open files.
func Run(o Options) (Result, error) {
	o.defaults()
	r := Result{DryRun: o.DryRun}
	if o.Proc == nil || o.Locks == nil || o.Signal == nil || o.StoreDir == "" || o.StateDir == "" {
		return r, errors.New("orphan reaper misconfigured")
	}
	s := &scan{o: o, now: o.Clock.Now(), procs: map[int]Process{}, all: map[int]Process{}, env: map[int]map[string]string{}}
	pids, err := o.Proc.PIDs()
	if err != nil {
		return r, err
	}
	for _, pid := range pids {
		p, err := o.Proc.Process(pid)
		if err != nil {
			continue // gone or unreadable foreign process
		}
		s.all[pid] = p
		// The reaper's own probe descriptors must not count as a holder.
		if p.UID == o.UID && pid != o.Self {
			s.procs[pid] = p
		}
	}
	s.leaders(&r)
	s.runtimes(&r)
	s.logs(&r)
	return r, nil
}

// ---- leaders ----

func (s *scan) isManagedLeader(p Process) bool {
	if p.UID != s.o.UID || p.Exe == "" || len(p.Argv) < 3 || p.Argv[1] != "agent" || p.Argv[2] != "leader" {
		return false
	}
	return filepath.Base(p.Exe) == "grok" && within(s.o.StoreDir, p.Exe)
}

func within(root, path string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}

// isWrapper names cgx/cxx itself (any persona, any version, replaced or not).
func isWrapper(p Process) bool {
	if filepath.Base(p.Exe) == "cxx" {
		return true
	}
	if len(p.Argv) > 0 {
		switch filepath.Base(p.Argv[0]) {
		case "cxx", "cgx", "cdx", "clx":
			return true
		}
	}
	return false
}

func (s *scan) environ(pid int) (map[string]string, error) {
	if e, ok := s.env[pid]; ok {
		return e, nil
	}
	e, err := s.o.Proc.Environ(pid)
	if err != nil {
		return nil, err
	}
	s.env[pid] = e
	return e, nil
}

// runtimeOf derives the private runtime directory a native process is bound
// to. Only directories directly below <state>/runtimes count.
func (s *scan) runtimeOf(env map[string]string) string {
	root := filepath.Join(s.o.StateDir, "runtimes")
	for _, key := range []string{"CXX_GROK_SOCKET", "CXX_GROK_AUTH_SOCKET", "GROK_HOME", "GROK_AUTH_PATH"} {
		v := env[key]
		if v == "" || !filepath.IsAbs(v) || !within(root, v) {
			continue
		}
		rel, _ := filepath.Rel(root, v)
		first := strings.SplitN(rel, string(os.PathSeparator), 2)[0]
		if strings.HasPrefix(first, "session-") {
			return filepath.Join(root, first)
		}
	}
	return ""
}

func referencesDir(env map[string]string, dir string) bool {
	for _, key := range []string{"GROK_HOME", "GROK_AUTH_PATH", "CXX_GROK_SOCKET", "CXX_GROK_AUTH_SOCKET"} {
		v := env[key]
		if v == dir || strings.HasPrefix(v, dir+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func (s *scan) descendantOf(pid, ancestor int) bool {
	for depth := 0; depth < 128 && pid > 1; depth++ {
		p, ok := s.all[pid]
		if !ok {
			return false
		}
		if p.PPID == ancestor {
			return true
		}
		pid = p.PPID
	}
	return false
}

// supervised reports a live wrapper or native client among the ancestors.
func (s *scan) supervised(p Process) string {
	pid := p.PPID
	for depth := 0; depth < 128 && pid > 1; depth++ {
		a, ok := s.all[pid]
		if !ok {
			// An unreadable ancestor cannot be proven harmless.
			if _, err := s.o.Proc.Process(pid); errors.Is(err, ErrGone) {
				return ""
			}
			return "ancestor_unreadable"
		}
		if isWrapper(a) {
			return "supervised_by_wrapper"
		}
		if within(s.o.StoreDir, a.Exe) {
			return "attached_native_parent"
		}
		pid = a.PPID
	}
	return ""
}

// relevant names a process that could be a wrapper or native Grok. Its
// environment and descriptors must be readable before anything is removed.
func (s *scan) relevant(pid int) bool {
	p := s.all[pid]
	if isWrapper(p) || within(s.o.StoreDir, p.Exe) || len(p.Argv) == 0 {
		return true
	}
	return filepath.Base(p.Argv[0]) == "grok" || within(s.o.StoreDir, p.Argv[0])
}

// skippable reports a read failure that cannot hide a holder: the process is
// gone, or it is an unrelated non-dumpable process (ssh-agent, gpg-agent)
// whose environment and descriptors the kernel hides from its own user.
func (s *scan) skippable(pid int, err error) bool {
	if errors.Is(err, ErrGone) || errors.Is(err, os.ErrNotExist) {
		return true
	}
	return errors.Is(err, os.ErrPermission) && !s.relevant(pid)
}

// clientAttached reports another process (not the leader or its own
// children) bound to the same private runtime.
func (s *scan) clientAttached(leader Process, dir string) (bool, error) {
	for pid := range s.procs {
		if pid == leader.PID || s.descendantOf(pid, leader.PID) {
			continue
		}
		env, err := s.environ(pid)
		if err != nil {
			if s.skippable(pid, err) {
				continue
			}
			return true, err
		}
		if referencesDir(env, dir) {
			return true, nil
		}
	}
	return false, nil
}

func (s *scan) leaders(r *Result) {
	var pids []int
	for pid, p := range s.procs {
		if s.isManagedLeader(p) {
			pids = append(pids, pid)
		}
	}
	sort.Ints(pids)
	signalled := 0
	for _, pid := range pids {
		p := s.procs[pid]
		it := Item{Kind: "leader", PID: pid, Age: s.now.Sub(p.Start)}
		reason := s.leaderVeto(p, &it)
		switch {
		case reason != "":
			it.Action, it.Reason = "skipped", reason
		case s.o.DryRun:
			it.Action = "would_reap"
		case signalled >= s.o.MaxLeaders:
			it.Action, it.Reason = "skipped", "batch_limit"
		default:
			signalled++
			it.Action, it.Reason = s.terminate(p)
		}
		r.Items = append(r.Items, it)
	}
}

func (s *scan) leaderVeto(p Process, it *Item) string {
	if it.Age < s.o.LeaderAge {
		return "young"
	}
	if why := s.supervised(p); why != "" {
		return why
	}
	env, err := s.environ(p.PID)
	if err != nil {
		return "environ_unreadable"
	}
	dir := s.runtimeOf(env)
	if dir == "" {
		return "no_runtime_binding"
	}
	it.Path = dir
	// The launching wrapper holds the private lease for the session's whole
	// life; an orphan only kept the descriptor, whose flock cgx released.
	release, err := s.o.Locks.TryExclusive(filepath.Join(dir, privateLeaseName))
	switch {
	case errors.Is(err, ErrHeld):
		return "lease_held"
	case errors.Is(err, os.ErrNotExist):
		return "lease_missing"
	case err != nil:
		return "lease_probe_failed"
	}
	release()
	attached, err := s.clientAttached(p, dir)
	if err != nil {
		return "client_check_failed"
	}
	if attached {
		return "client_attached"
	}
	return ""
}

// verifier re-reads the process and compares every identity field.
func (s *scan) verifier(want Process) func() error {
	return func() error {
		got, err := s.o.Proc.Process(want.PID)
		if err != nil {
			if errors.Is(err, ErrGone) {
				return ErrGone
			}
			return err
		}
		if got.StartTicks != want.StartTicks || got.UID != want.UID || got.Exe != want.Exe || strings.Join(got.Argv, "\x00") != strings.Join(want.Argv, "\x00") {
			return ErrIdentityChanged
		}
		return nil
	}
}

// waitGone polls until the process exits or the grace runs out.
func (s *scan) waitGone(verify func() error, grace time.Duration) (bool, error) {
	deadline := s.o.Clock.Now().Add(grace)
	for {
		err := verify()
		if errors.Is(err, ErrGone) || errors.Is(err, ErrIdentityChanged) {
			return true, nil
		}
		if err != nil {
			return false, err
		}
		if !s.o.Clock.Now().Before(deadline) {
			return false, nil
		}
		s.o.Clock.Sleep(pollInterval)
	}
}

func (s *scan) terminate(p Process) (action, reason string) {
	verify := s.verifier(p)
	err := s.o.Signal.Signal(p.PID, syscall.SIGTERM, verify)
	switch {
	case errors.Is(err, ErrGone):
		return "reaped", "exited_before_signal"
	case errors.Is(err, ErrIdentityChanged):
		return "skipped", "identity_changed"
	case err != nil:
		return "failed", "sigterm: " + errText(err)
	}
	if gone, err := s.waitGone(verify, s.o.TermGrace); err != nil {
		return "failed", "wait: " + errText(err)
	} else if gone {
		return "reaped", "sigterm"
	}
	err = s.o.Signal.Signal(p.PID, syscall.SIGKILL, verify)
	switch {
	case errors.Is(err, ErrGone), errors.Is(err, ErrIdentityChanged):
		return "reaped", "sigterm"
	case err != nil:
		return "failed", "sigkill: " + errText(err)
	}
	if gone, err := s.waitGone(verify, s.o.KillGrace); err != nil || !gone {
		return "failed", "survived_sigkill"
	}
	return "reaped", "sigkill"
}

func errText(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno.Error()
	}
	return err.Error()
}

// ---- runtime directories and logs ----

func (s *scan) openFiles() (map[string]bool, error) {
	if s.open != nil || s.openErr != nil {
		return s.open, s.openErr
	}
	s.open = map[string]bool{}
	for pid := range s.procs {
		files, err := s.o.Proc.OpenFiles(pid)
		if err != nil {
			if s.skippable(pid, err) {
				continue
			}
			s.open, s.openErr = nil, err
			return nil, err
		}
		for _, f := range files {
			s.open[f] = true
		}
	}
	return s.open, nil
}

func (s *scan) dirInUse(dir string) (string, error) {
	for pid := range s.procs {
		env, err := s.environ(pid)
		if err != nil {
			if s.skippable(pid, err) {
				continue
			}
			return "", err
		}
		if referencesDir(env, dir) {
			return "in_use", nil
		}
	}
	open, err := s.openFiles()
	if err != nil {
		return "", err
	}
	for path := range open {
		if path == dir || strings.HasPrefix(path, dir+string(os.PathSeparator)) {
			return "open_files", nil
		}
	}
	return "", nil
}

func ownedBy(info os.FileInfo, uid uint32) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && st.Uid == uid
}

// newestTop is the newest mtime of dir and its direct entries. The private
// home below is excluded: an orphan leader keeps writing its own logs there.
func newestTop(dir string, info os.FileInfo) time.Time {
	newest := info.ModTime()
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if fi, err := e.Info(); err == nil && fi.ModTime().After(newest) && e.Name() != "home" {
			newest = fi.ModTime()
		}
	}
	return newest
}

func (s *scan) runtimes(r *Result) {
	root := filepath.Join(s.o.StateDir, "runtimes")
	entries, err := os.ReadDir(root)
	if err != nil {
		if !os.IsNotExist(err) {
			r.Errors = append(r.Errors, "runtimes: "+errText(err))
		}
		return
	}
	removed := 0
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "session-") {
			continue
		}
		dir := filepath.Join(root, e.Name())
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ownedBy(info, s.o.UID) {
			continue // never ours to judge
		}
		it := Item{Kind: "runtime", Path: dir, Age: s.now.Sub(newestTop(dir, info))}
		var releases []func()
		reason := func() string {
			if it.Age < s.o.RuntimeAge {
				return "young"
			}
			// grok.lock is native's own leader lock; the private lease is
			// the wrapper's. Either one held means a live session.
			for _, lock := range [][2]string{{"grok.lock", "grok_lock_held"}, {privateLeaseName, "lease_held"}} {
				release, err := s.o.Locks.TryExclusive(filepath.Join(dir, lock[0]))
				switch {
				case errors.Is(err, os.ErrNotExist):
					continue
				case errors.Is(err, ErrHeld):
					return lock[1]
				case err != nil:
					return "lock_probe_failed"
				}
				releases = append(releases, release)
			}
			why, err := s.dirInUse(dir)
			if err != nil {
				return "in_use_check_failed"
			}
			return why
		}()
		switch {
		case reason != "":
			it.Action, it.Reason = "skipped", reason
		case s.o.DryRun:
			it.Action = "would_remove"
		case removed >= s.o.MaxRuntimes:
			it.Action, it.Reason = "skipped", "batch_limit"
		default:
			// Locks stay held across removal; RemoveAll unlinks the home's
			// links to the shared native store without following them.
			if err := os.RemoveAll(dir); err != nil {
				it.Action, it.Reason = "failed", errText(err)
			} else {
				removed++
				it.Action = "removed"
			}
		}
		for _, release := range releases {
			release()
		}
		r.Items = append(r.Items, it)
	}
}

func (s *scan) logs(r *Result) {
	dir := filepath.Join(s.o.StateDir, "leader-logs")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !os.IsNotExist(err) {
			r.Errors = append(r.Errors, "leader-logs: "+errText(err))
		}
		return
	}
	removed := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "grok-") || !strings.HasSuffix(name, ".log") {
			continue
		}
		path := filepath.Join(dir, name)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || !ownedBy(info, s.o.UID) {
			continue
		}
		it := Item{Kind: "log", Path: path, Age: s.now.Sub(info.ModTime())}
		threshold := s.o.LogAge
		if info.Size() == 0 {
			threshold = s.o.EmptyLogAge
		}
		if it.Age < threshold {
			it.Action, it.Reason = "skipped", "young"
			r.Items = append(r.Items, it)
			continue
		}
		open, err := s.openFiles()
		switch {
		case err != nil:
			it.Action, it.Reason = "skipped", "open_check_failed"
		case open[path]:
			it.Action, it.Reason = "skipped", "open"
		case s.o.DryRun:
			it.Action = "would_remove"
		case removed >= s.o.MaxLogs:
			it.Action, it.Reason = "skipped", "batch_limit"
		default:
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				it.Action, it.Reason = "failed", errText(err)
			} else {
				removed++
				it.Action = "removed"
			}
		}
		r.Items = append(r.Items, it)
	}
}

// ---- reporting ----

// Summary is the one cron.log line: counts per outcome and every skip reason.
func (r Result) Summary() string {
	done := map[string]int{}
	type key struct{ kind, reason string }
	skipped := map[key]int{}
	failed := map[key]int{}
	for _, it := range r.Items {
		switch it.Action {
		case "reaped", "would_reap", "removed", "would_remove":
			done[it.Kind]++
		case "skipped":
			// A young leader is reported (it may be what defers housekeeping
			// until it ages out); young runtimes and logs are routine.
			if it.Reason != "young" || it.Kind == "leader" {
				skipped[key{it.Kind, it.Reason}]++
			}
		case "failed":
			failed[key{it.Kind, it.Reason}]++
		}
	}
	verb, prefix := "reaped", "reaper grok: "
	if r.DryRun {
		verb, prefix = "would reap", "reaper grok (dry-run): "
	}
	line := fmt.Sprintf("%s%s %d leader(s), %d runtime dir(s), %d leader log(s)", prefix, verb, done["leader"], done["runtime"], done["log"])
	render := func(label string, m map[key]int) {
		if len(m) == 0 {
			return
		}
		var parts []string
		for k, n := range m {
			parts = append(parts, fmt.Sprintf("%d %s %s", n, k.kind, k.reason))
		}
		sort.Strings(parts)
		line += "; " + label + " " + strings.Join(parts, ", ")
	}
	render("skipped", skipped)
	render("failed", failed)
	if len(r.Errors) > 0 {
		line += "; errors: " + strings.Join(r.Errors, "; ")
	}
	return line
}

// Details lists leaders (always) and the runtime directories and logs that
// were or would be removed, for --dry-run and doctor output.
func (r Result) Details() []string {
	var out []string
	logs := 0
	for _, it := range r.Items {
		switch {
		case it.Kind == "leader":
			line := fmt.Sprintf("leader pid %d age %s: %s", it.PID, roundAge(it.Age), it.Action)
			if it.Reason != "" {
				line += " (" + it.Reason + ")"
			}
			if it.Path != "" {
				line += " runtime " + filepath.Base(it.Path)
			}
			out = append(out, line)
		case it.Kind == "runtime" && it.Reason != "young":
			line := fmt.Sprintf("runtime %s age %s: %s", filepath.Base(it.Path), roundAge(it.Age), it.Action)
			if it.Reason != "" {
				line += " (" + it.Reason + ")"
			}
			out = append(out, line)
		case it.Kind == "log" && (it.Action == "would_remove" || it.Action == "removed"):
			logs++
		case it.Kind == "log" && it.Reason != "young":
			out = append(out, fmt.Sprintf("log %s: %s (%s)", filepath.Base(it.Path), it.Action, it.Reason))
		}
	}
	if logs > 0 {
		out = append(out, fmt.Sprintf("%d leader log(s) past retention", logs))
	}
	return out
}

func roundAge(d time.Duration) string {
	if d >= 48*time.Hour {
		return fmt.Sprintf("%dd%dh", int(d/(24*time.Hour)), int(d%(24*time.Hour)/time.Hour))
	}
	return d.Truncate(time.Minute).String()
}

// Pending reports whether anything was or would be reaped.
func (r Result) Pending() (leaders, runtimes, logs int) {
	for _, it := range r.Items {
		if it.Action != "would_reap" && it.Action != "would_remove" && it.Action != "reaped" && it.Action != "removed" {
			continue
		}
		switch it.Kind {
		case "leader":
			leaders++
		case "runtime":
			runtimes++
		case "log":
			logs++
		}
	}
	return
}
