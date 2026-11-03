//go:build linux

package workload

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func fixtureStore(t *testing.T) store { t.Helper(); return store{dir: t.TempDir(), proc: "/proc"} }
func generous() (memoryView, error)   { return memoryView{available: 1000, capacity: 1000}, nil }

func TestParseRunRequiresExplicitMemoryAndPreservesCommand(t *testing.T) {
	o, e := parseRun([]string{"--memory", "8GiB", "--wait", "2s", "--reserve", "1GiB", "--", "sh", "-c", "exit 7"}, &bytes.Buffer{})
	if e != nil || o.memory != 8<<30 || o.reserve != 1<<30 || o.wait != 2*time.Second || strings.Join(o.command, "|") != "sh|-c|exit 7" {
		t.Fatalf("%+v %v", o, e)
	}
	for _, args := range [][]string{{"--", "true"}, {"--memory", "0GiB", "--", "true"}, {"--memory", "18446744073709551615GiB", "--", "true"}, {"--memory", "1GiB", "--wait", "-1s", "--", "true"}, {"--memory", "1GiB"}} {
		if _, e := parseRun(args, &bytes.Buffer{}); e == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestMemoryUsesRAMAndAllCgroupAncestors(t *testing.T) {
	p, c := t.TempDir(), t.TempDir()
	mustWrite(t, filepath.Join(p, "meminfo"), "MemTotal: 16777216 kB\nMemAvailable: 12582912 kB\nSwapFree: 33554432 kB\n")
	mustWrite(t, filepath.Join(p, "self/cgroup"), "0::/parent/job\n")
	mustWrite(t, filepath.Join(p, "self/mountinfo"), "1 0 0:1 / "+c+" rw - cgroup2 cgroup rw\n")
	mustWrite(t, filepath.Join(c, "parent/job/memory.max"), "8589934592")
	mustWrite(t, filepath.Join(c, "parent/job/memory.current"), "1073741824")
	mustWrite(t, filepath.Join(c, "parent/memory.max"), "4294967296")
	mustWrite(t, filepath.Join(c, "parent/memory.current"), "2147483648")
	v, e := readMemory(p, c)
	if e != nil {
		t.Fatal(e)
	}
	if v.available != 2<<30 || v.capacity != 4<<30 {
		t.Fatalf("%+v", v)
	}
	if got := usable(v, 1<<30, 256<<20); got != 768<<20 {
		t.Fatalf("got %d; swap must never increase admission", got)
	}
	mustWrite(t, filepath.Join(p, "self/cgroup"), "4:memory:/job\n")
	if _, e = readMemory(p, c); e == nil {
		t.Fatal("v1 accepted")
	}
	mustWrite(t, filepath.Join(p, "self/cgroup"), "0::/missing\n")
	if _, e = readMemory(p, c); e == nil {
		t.Fatal("missing constraint accepted")
	}
}

func TestMemoryNamespaceRootAndBadObservations(t *testing.T) {
	p, c := t.TempDir(), t.TempDir()
	mustWrite(t, filepath.Join(p, "meminfo"), "MemTotal: 1024000 kB\nMemAvailable: 512000 kB\n")
	mustWrite(t, filepath.Join(p, "self/cgroup"), "0::/namespace\n")
	mustWrite(t, filepath.Join(p, "self/mountinfo"), "1 0 0:1 /namespace "+c+" rw - cgroup2 cgroup rw\n")
	mustWrite(t, filepath.Join(c, "memory.max"), "100000000")
	mustWrite(t, filepath.Join(c, "memory.current"), "120000000")
	v, e := readMemory(p, c)
	if e != nil || v.available != 0 {
		t.Fatalf("%+v %v", v, e)
	}
	mustWrite(t, filepath.Join(c, "memory.current"), "invalid")
	if _, e = readMemory(p, c); e == nil {
		t.Fatal("bad memory accepted")
	}
	mustWrite(t, filepath.Join(p, "meminfo"), "MemTotal: 1024000 kB\n")
	if _, e = readMemory(p, c); e == nil {
		t.Fatal("missing available accepted")
	}
}

func TestAdmissionHoldCancelAndLockBudget(t *testing.T) {
	s := fixtureStore(t)
	var out bytes.Buffer
	if e := control(context.Background(), s, "hold", &out); e != nil {
		t.Fatal(e)
	}
	if _, e := s.admitted(context.Background(), 10, 1, generous); !errors.Is(e, errHeld) {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if _, e := waitAdmission(ctx, s, options{memory: 10, reserve: 1, wait: time.Second}, generous, func() {}); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal(e)
	}
	if e := control(context.Background(), s, "resume", &out); e != nil {
		t.Fatal(e)
	}
	f, e := s.lock(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	defer unlock(f)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel2()
	if _, e = s.lock(ctx2); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal(e)
	}
}

func TestReservationsRejectOvercommitAndRetainCrashUncertainty(t *testing.T) {
	s := fixtureStore(t)
	r, e := s.admitted(context.Background(), 700, 1, generous)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.admitted(context.Background(), 400, 1, generous); !errors.Is(e, errCapacity) {
		t.Fatalf("overcommit: %v", e)
	}
	r.Owner = 1 << 30
	r.Group = 1 << 30
	if e = s.write(r); e != nil {
		t.Fatal(e)
	}
	_, total, e := s.reservations()
	if e != nil || total != 700 {
		t.Fatalf("uncertain capacity released: %d %v", total, e)
	}
	if e = releaseUncertain(context.Background(), s, r.ID); e != nil {
		t.Fatal(e)
	}
	r.Group = 0
	if e = s.write(r); e != nil {
		t.Fatal(e)
	}
	_, total, e = s.reservations()
	if e != nil || total != 0 {
		t.Fatalf("pending record not cleaned: %d %v", total, e)
	}
	mustWrite(t, filepath.Join(s.dir, "corrupt.json"), "{")
	if _, _, e = s.reservations(); e == nil {
		t.Fatal("corrupt reservation ignored")
	}
}

func TestReservationsRefuseReleaseWhileOwnerRuns(t *testing.T) {
	s := fixtureStore(t)
	r, e := s.admitted(context.Background(), 100, 1, generous)
	if e != nil {
		t.Fatal(e)
	}
	if e = releaseUncertain(context.Background(), s, r.ID); e == nil {
		t.Fatal("live reservation released")
	}
	removeReservation(s, r)
	_, total, e := s.reservations()
	if e != nil || total != 0 {
		t.Fatalf("release: %d %v", total, e)
	}
}

func helperCmd(dir, mode string, args ...string) *exec.Cmd {
	c := exec.Command(os.Args[0], append([]string{"-test.run=^TestWorkloadProcessHelper$", "--", mode}, args...)...)
	c.Env = append(os.Environ(), "CXX_WORKLOAD_TEST_HELPER=1", "CXX_WORKLOAD_TEST_DIR="+dir)
	return c
}

func TestCrossProcessAdmissionIsSerialized(t *testing.T) {
	dir := t.TempDir()
	type result struct {
		out bytes.Buffer
		cmd *exec.Cmd
	}
	jobs := make([]*result, 4)
	for i := range jobs {
		j := &result{cmd: helperCmd(dir, "reserve")}
		j.cmd.Stdout = &j.out
		j.cmd.Stderr = &j.out
		jobs[i] = j
		if e := j.cmd.Start(); e != nil {
			t.Fatal(e)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		files, _ := filepath.Glob(filepath.Join(dir, "attempt-*"))
		if len(files) == len(jobs) {
			break
		}
		if time.Now().After(deadline) {
			for _, j := range jobs {
				_ = j.cmd.Process.Kill()
			}
			t.Fatal("admission helpers did not finish their attempts")
		}
		time.Sleep(10 * time.Millisecond)
	}
	mustWrite(t, filepath.Join(dir, "release"), "")
	accepted := 0
	for _, j := range jobs {
		if e := j.cmd.Wait(); e != nil {
			t.Fatalf("%s %v", j.out.String(), e)
		}
		if strings.Contains(j.out.String(), "accepted") {
			accepted++
		}
	}
	if accepted != 1 {
		t.Fatalf("admitted %d overlapping 700-byte jobs from a 999-byte budget", accepted)
	}
}

func TestJobWaitsForDetachedDescendantAndPreservesExit(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "finished")
	cmd := helperCmd(dir, "driver", "sh", "-c", `setsid sh -c 'sleep .25; touch "$1"' sh "$1" </dev/null >/dev/null 2>&1 & exit 7`, "sh", marker)
	out, e := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(e, &exit) || exit.ExitCode() != 7 {
		t.Fatalf("exit %v: %s", e, out)
	}
	if _, e = os.Stat(marker); e != nil {
		t.Fatalf("released before detached descendant finished: %v", e)
	}
	s := store{dir: dir, proc: "/proc"}
	_, total, e := s.reservations()
	if e != nil || total != 0 {
		t.Fatalf("reservation leaked %d %v", total, e)
	}
}

func TestJobRunsNicedAndStartFailureReleases(t *testing.T) {
	dir := t.TempDir()
	out, e := helperCmd(dir, "driver", "sh", "-c", `ps -o ni= -p $$`).CombinedOutput()
	if e != nil {
		t.Fatalf("%s %v", out, e)
	}
	n, e := strconv.Atoi(strings.TrimSpace(string(out)))
	if e != nil || n < 10 {
		t.Fatalf("priority %q %v", out, e)
	}
	s := fixtureStore(t)
	r, e := s.admitted(context.Background(), 1, 1, generous)
	if e != nil {
		t.Fatal(e)
	}
	var b bytes.Buffer
	if code := runJob(context.Background(), s, r, exec.Command(filepath.Join(t.TempDir(), "missing")), &b); code == 0 {
		t.Fatal("missing command succeeded")
	}
	_, total, e := s.reservations()
	if e != nil || total != 0 {
		t.Fatalf("failed start leaked %d %v", total, e)
	}
}

func TestCanceledAdmissionNeverStartsTheCommand(t *testing.T) {
	s := fixtureStore(t)
	r, e := s.admitted(context.Background(), 1, 1, generous)
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	marker := filepath.Join(s.dir, "must-not-exist")
	var out bytes.Buffer
	if code := runJob(ctx, s, r, exec.Command("touch", marker), &out); code == 0 {
		t.Fatal("canceled launch succeeded")
	}
	if _, e := os.Stat(marker); !os.IsNotExist(e) {
		t.Fatalf("canceled launch executed: %v", e)
	}
	_, total, e := s.reservations()
	if e != nil || total != 0 {
		t.Fatalf("canceled launch leaked %d %v", total, e)
	}
}

func TestChildCannotExecuteAfterReservationWasLost(t *testing.T) {
	s := fixtureStore(t)
	r, e := s.admitted(context.Background(), 1, 1, generous)
	if e != nil {
		t.Fatal(e)
	}
	removeReservation(s, r)
	marker := filepath.Join(s.dir, "must-not-exist")
	cmd := helperCmd(s.dir, "child", r.ID, "--", "touch", marker)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if out, e := cmd.CombinedOutput(); e == nil {
		t.Fatalf("lost reservation executed: %s", out)
	}
	if _, e := os.Stat(marker); !os.IsNotExist(e) {
		t.Fatalf("barrier bypass: %v", e)
	}
}

func TestWorkloadProcessHelper(t *testing.T) {
	if os.Getenv("CXX_WORKLOAD_TEST_HELPER") != "1" {
		return
	}
	i := 0
	for i < len(os.Args) && os.Args[i] != "--" {
		i++
	}
	args := os.Args[i+1:]
	s := store{dir: os.Getenv("CXX_WORKLOAD_TEST_DIR"), proc: "/proc"}
	switch args[0] {
	case "reserve":
		r, e := s.admitted(context.Background(), 700, 1, generous)
		if err := os.WriteFile(filepath.Join(s.dir, fmt.Sprintf("attempt-%d", os.Getpid())), nil, 0600); err != nil {
			os.Exit(1)
		}
		if errors.Is(e, errCapacity) {
			fmt.Println("rejected")
			os.Exit(0)
		}
		if e != nil {
			fmt.Println(e)
			os.Exit(1)
		}
		fmt.Println("accepted")
		for {
			if _, err := os.Stat(filepath.Join(s.dir, "release")); err == nil {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		removeReservation(s, r)
		os.Exit(0)
	case "child":
		if e := child(s, args[1:]); e != nil {
			fmt.Println(e)
			os.Exit(1)
		}
	case "driver":
		r, e := s.admitted(context.Background(), 1, 1, generous)
		if e != nil {
			fmt.Println(e)
			os.Exit(1)
		}
		cmd := helperCmd(s.dir, "child", append([]string{r.ID, "--"}, args[1:]...)...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		os.Exit(runJob(context.Background(), s, r, cmd, os.Stderr))
	}
	os.Exit(1)
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, []byte(body), 0600); e != nil {
		t.Fatal(e)
	}
}
