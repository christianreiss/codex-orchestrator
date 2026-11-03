//go:build linux

package workload

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

func platformCommand(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	s, err := openStore()
	if err != nil {
		fmt.Fprintln(stderr, "cxx workload:", err)
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	if args[0] == "_exec" {
		err = child(s, args[1:])
		fmt.Fprintln(stderr, "cxx workload:", err)
		return 1
	}
	if args[0] == "release" {
		if len(args) != 3 || args[2] != "--confirm-finished" {
			fmt.Fprintln(stderr, "usage: cxx workload release ID --confirm-finished (verify all job descendants ended first)")
			return 2
		}
		err = releaseUncertain(ctx, s, args[1])
		if err != nil {
			fmt.Fprintln(stderr, "cxx workload:", err)
			return 1
		}
		fmt.Fprintln(stdout, "Finished job reservation released.")
		return 0
	}
	if args[0] != "run" {
		if len(args) != 1 {
			fmt.Fprintln(stderr, "cxx workload: unexpected arguments")
			return 2
		}
		err = control(ctx, s, args[0], stdout)
		if err != nil {
			fmt.Fprintln(stderr, "cxx workload:", err)
			return 1
		}
		return 0
	}
	opts, err := parseRun(args[1:], stderr)
	if err != nil {
		fmt.Fprintln(stderr, "cxx workload:", err)
		return 2
	}
	admissionCtx := ctx
	var timeout context.CancelFunc = func() {}
	if opts.wait > 0 {
		admissionCtx, timeout = context.WithTimeout(ctx, opts.wait)
	} else {
		// No queueing by default; bound even metadata-lock contention.
		admissionCtx, timeout = context.WithTimeout(ctx, 250*time.Millisecond)
	}
	defer timeout()
	sample := func() (memoryView, error) { return readMemory("/proc", "/sys/fs/cgroup") }
	r, err := waitAdmission(admissionCtx, s, opts, sample, func() { fmt.Fprintln(stderr, "cxx workload: waiting for memory or workload resume") })
	if err != nil {
		fmt.Fprintln(stderr, "cxx workload: job not started:", err)
		return 1
	}
	exe, err := os.Executable()
	if err != nil {
		removeReservation(s, r)
		fmt.Fprintln(stderr, "cxx workload:", err)
		return 1
	}
	cmd := exec.Command(exe, append([]string{"workload", "_exec", r.ID, "--"}, opts.command...)...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return runJob(ctx, s, r, cmd, stderr)
}

func waitAdmission(ctx context.Context, s store, opts options, sample func() (memoryView, error), waiting func()) (reservation, error) {
	notified := false
	for {
		r, err := s.admitted(ctx, opts.memory, opts.reserve, sample)
		if err == nil {
			return r, nil
		}
		if (!errors.Is(err, errHeld) && !errors.Is(err, errCapacity)) || opts.wait == 0 {
			return r, err
		}
		if !notified {
			waiting()
			notified = true
		}
		select {
		case <-ctx.Done():
			return reservation{}, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// The child publishes its process group before it may exec the job. If the
// wrapper crashes in the fork/start window, cleanup cannot erase a running job's
// reservation: either publication wins under lock, or the child refuses to exec.
func child(s store, args []string) error {
	if len(args) < 3 || args[1] != "--" {
		return fmt.Errorf("invalid workload child")
	}
	if _, err := uuid.Parse(args[0]); err != nil {
		return fmt.Errorf("invalid workload child")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f, err := s.lock(ctx)
	if err != nil {
		return err
	}
	r, err := s.read(args[0] + ".json")
	if err != nil {
		unlock(f)
		return err
	}
	if r.Group != 0 || r.Owner != os.Getppid() {
		unlock(f)
		return fmt.Errorf("workload owner changed")
	}
	_, start, alive, err := s.process(r.Owner)
	if err != nil || !alive || start != r.Start {
		unlock(f)
		return fmt.Errorf("workload owner unavailable")
	}
	r.Group = unix.Getpgrp()
	if r.Group != os.Getpid() {
		unlock(f)
		return fmt.Errorf("workload child lacks private process group")
	}
	err = s.write(r)
	unlock(f)
	if err != nil {
		return err
	}
	// Lower only this explicit job, never the native agent or desktop. nice is
	// inherited by normal children. Do not add memory/swap/tasks/cpu hard limits.
	// Linux nice is per thread; pin the goroutine until exec replaces this thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	priority, err := unix.Getpriority(unix.PRIO_PROCESS, 0)
	if err != nil {
		return err
	}
	// Linux getpriority returns 20 - nice (unlike libc's normalized wrapper).
	if 20-priority < 10 {
		if err = unix.Setpriority(unix.PRIO_PROCESS, 0, 10); err != nil {
			return err
		}
	}
	path, err := exec.LookPath(args[2])
	if err != nil {
		return err
	}
	return unix.Exec(path, args[2:], os.Environ())
}

func runJob(ctx context.Context, s store, r reservation, cmd *exec.Cmd, stderr io.Writer) int {
	// Cancellation is admission-only. Once started, only actual user signals
	// are forwarded; pressure and timeout never terminate this or any native job.
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT)
	defer signal.Stop(signals)
	if err := ctx.Err(); err != nil {
		removeReservation(s, r)
		fmt.Fprintln(stderr, "cxx workload: job not started:", err)
		return 1
	}
	if err := unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0); err != nil {
		removeReservation(s, r)
		fmt.Fprintln(stderr, "cxx workload: descendant tracking unavailable:", err)
		return 1
	}
	if err := cmd.Start(); err != nil {
		removeReservation(s, r)
		fmt.Fprintln(stderr, "cxx workload: job not started:", err)
		return 1
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var waitErr error
	waiting := true
	for waiting {
		select {
		case sig := <-signals:
			_ = unix.Kill(-cmd.Process.Pid, sig.(syscall.Signal))
		case waitErr = <-done:
			waiting = false
		}
	}
	// Subreaper adoption tracks orphaned descendants even if they call setsid.
	// Wait only after cmd.Wait, so we never steal its direct-child exit status.
	for {
		var status unix.WaitStatus
		pid, err := unix.Wait4(-1, &status, unix.WNOHANG, nil)
		if errors.Is(err, unix.ECHILD) {
			break
		}
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			fmt.Fprintln(stderr, "cxx workload: reservation retained; process observation failed:", err)
			return 1
		}
		if pid > 0 {
			continue
		}
		select {
		case sig := <-signals:
			_ = unix.Kill(-cmd.Process.Pid, sig.(syscall.Signal))
		case <-time.After(200 * time.Millisecond):
		}
	}
	removeReservation(s, r)
	if waitErr == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(waitErr, &exit) {
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal())
		}
		return exit.ExitCode()
	}
	fmt.Fprintln(stderr, "cxx workload:", waitErr)
	return 1
}

func removeReservation(s store, r reservation) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f, err := s.lock(ctx)
	if err == nil {
		_ = os.Remove(filepath.Join(s.dir, r.ID+".json"))
		unlock(f)
	} // Failed cleanup retains capacity conservatively for manual reconciliation.
}

func releaseUncertain(ctx context.Context, s store, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return fmt.Errorf("invalid reservation ID")
	}
	f, err := s.lock(ctx)
	if err != nil {
		return err
	}
	defer unlock(f)
	r, err := s.read(id + ".json")
	if err != nil {
		return err
	}
	_, start, alive, err := s.process(r.Owner)
	if err != nil {
		return err
	}
	if alive && start == r.Start {
		return fmt.Errorf("job wrapper is still running")
	}
	alive, err = s.groupAlive(r.Group)
	if err != nil {
		return err
	}
	if alive {
		return fmt.Errorf("job process group is still running")
	}
	return os.Remove(filepath.Join(s.dir, id+".json"))
}

func control(ctx context.Context, s store, action string, out io.Writer) error {
	f, err := s.lock(ctx)
	if err != nil {
		return err
	}
	defer unlock(f)
	switch action {
	case "hold":
		f, err := os.OpenFile(filepath.Join(s.dir, "hold"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if os.IsExist(err) {
			fmt.Fprintln(out, "New jobs are on hold; running jobs continue.")
			return nil
		}
		if err != nil {
			return err
		}
		if err = f.Close(); err != nil {
			return err
		}
		fmt.Fprintln(out, "New jobs are on hold; running jobs continue.")
	case "resume":
		if err = os.Remove(filepath.Join(s.dir, "hold")); err != nil && !os.IsNotExist(err) {
			return err
		}
		fmt.Fprintln(out, "New jobs may request memory again.")
	case "status":
		records, total, err := s.reservations()
		if err != nil {
			return err
		}
		v, err := readMemory("/proc", "/sys/fs/cgroup")
		if err != nil {
			return err
		}
		_, held := os.Lstat(filepath.Join(s.dir, "hold"))
		if held != nil && !os.IsNotExist(held) {
			return held
		}
		fmt.Fprintf(out, "hold=%t jobs=%d reserved_bytes=%d available_ram_bytes=%d default_admissible_bytes=%d swap_free_bytes=%d\n", held == nil, len(records), total, v.available, usable(v, total, 0), v.swapFree)
		for _, r := range records {
			_, start, alive, err := s.process(r.Owner)
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "id=%s memory_bytes=%d uncertain=%t\n", r.ID, r.Memory, !alive || start != r.Start)
		}
		fmt.Fprintln(out, "Cooperative jobs for this user only; swap is diagnostic, never added to available RAM.")
	default:
		return fmt.Errorf("unknown workload action %q", action)
	}
	return nil
}
