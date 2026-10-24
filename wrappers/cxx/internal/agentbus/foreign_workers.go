package agentbus

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Feedback 845ba7f6: before 0.9.82 every user ran its own cxx-agent.service.
// After a host moves to the root-owned layout those users' workers can no
// longer read a config, and nothing running as them retires the unit: root's
// maintenance removed their crontab lines. Root maintenance therefore retires
// other accounts' legacy workers itself whenever the server's answer says
// they may not run one (docs/host-runtime-policy.md).

// workerProcess is one running `cxx agent worker --foreground`.
type workerProcess struct {
	PID int
	UID int
}

// passwdEntry is the part of /etc/passwd the sweep needs.
type passwdEntry struct {
	Name string
	UID  int
	Home string
}

var (
	foreignSweepRoot    = "/"
	foreignSweepEnabled = func() bool { return runtime.GOOS == "linux" && os.Geteuid() == 0 }
	foreignSweepPolicy  = func() (daemonSettings, bool) {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, _, settings, err := daemonConfig(ctx)
		return settings, err == nil
	}
	signalWorker = func(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }
)

// retireForeignWorkers is called by root's `agent service install`. It does
// nothing unless the server answered: an unknown answer changes nothing, the
// same rule as for root's own unit. Failures are reported, never returned.
func retireForeignWorkers(stderr io.Writer) {
	if !foreignSweepEnabled() {
		return
	}
	settings, ok := foreignSweepPolicy()
	if !ok {
		return
	}
	users, err := readPasswd(filepath.Join(foreignSweepRoot, "etc", "passwd"))
	if err != nil {
		fmt.Fprintln(stderr, "cxx agent: cannot list accounts for legacy worker retirement:", err)
		return
	}
	daemonUID, allowedUID := -1, false
	if hostPersistent(settings) {
		for _, entry := range users {
			if entry.Name == settings.Username && settings.Username != "" {
				daemonUID, allowedUID = entry.UID, true
			}
		}
		if !allowedUID {
			return // persistent, but the daemon account is not resolvable here: change nothing
		}
	}
	retire := func(uid int) bool { return uid != 0 && uid != daemonUID }
	for _, proc := range listWorkerProcesses(filepath.Join(foreignSweepRoot, "proc")) {
		if !retire(proc.UID) || proc.PID == os.Getpid() {
			continue
		}
		// SIGTERM ends the worker cleanly (exit 0): Restart=on-failure keeps it down.
		if err := signalWorker(proc.PID); err != nil && !errors.Is(err, syscall.ESRCH) {
			fmt.Fprintf(stderr, "cxx agent: stop legacy worker pid %d: %v\n", proc.PID, err)
			continue
		}
		fmt.Fprintf(stderr, "cxx agent: stopped legacy background worker pid %d (uid %d)\n", proc.PID, proc.UID)
	}
	for _, entry := range users {
		if !retire(entry.UID) || entry.Home == "" || entry.Home == "/" {
			continue
		}
		if removed, err := removeLegacyUserUnit(filepath.Join(foreignSweepRoot, entry.Home)); err != nil {
			fmt.Fprintf(stderr, "cxx agent: retire cxx-agent.service of %s: %v\n", entry.Name, err)
		} else if removed {
			fmt.Fprintf(stderr, "cxx agent: retired cxx-agent.service of %s\n", entry.Name)
		}
	}
}

// removeLegacyUserUnit deletes a cxx-written unit and its enablement link so
// the user's manager does not start it again at the next boot or login.
func removeLegacyUserUnit(home string) (bool, error) {
	dir := filepath.Join(home, ".config", "systemd", "user")
	unit := filepath.Join(dir, serviceName+".service")
	info, err := os.Lstat(unit)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, nil // never follow a link a user placed here
	}
	body, err := os.ReadFile(unit)
	if err != nil {
		return false, err
	}
	if !bytes.Contains(body, []byte(" agent worker --foreground")) {
		return false, nil // not ours
	}
	link := filepath.Join(dir, "default.target.wants", serviceName+".service")
	if err := os.Remove(link); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.Remove(unit); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	return true, nil
}

// listWorkerProcesses finds `<cxx|cdx|clx|cgx> agent worker --foreground`.
func listWorkerProcesses(procRoot string) []workerProcess {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil
	}
	var found []workerProcess
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(procRoot, entry.Name(), "cmdline"))
		if err != nil || !isWorkerCommandLine(raw) {
			continue
		}
		uid, ok := processUID(filepath.Join(procRoot, entry.Name(), "status"))
		if !ok {
			continue
		}
		found = append(found, workerProcess{PID: pid, UID: uid})
	}
	return found
}

func isWorkerCommandLine(raw []byte) bool {
	args := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
	if len(args) != 4 || args[1] != "agent" || args[2] != "worker" || args[3] != "--foreground" {
		return false
	}
	switch filepath.Base(strings.TrimSuffix(args[0], " (deleted)")) {
	case "cxx", "cdx", "clx", "cgx":
		return true
	}
	return false
}

func processUID(statusPath string) (int, bool) {
	file, err := os.Open(statusPath)
	if err != nil {
		return 0, false
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if rest, ok := strings.CutPrefix(scanner.Text(), "Uid:"); ok {
			fields := strings.Fields(rest)
			if len(fields) == 0 {
				return 0, false
			}
			uid, err := strconv.Atoi(fields[0])
			return uid, err == nil
		}
	}
	return 0, false
}

func readPasswd(path string) ([]passwdEntry, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var entries []passwdEntry
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Split(line, ":")
		if len(fields) < 7 || strings.HasPrefix(line, "#") {
			continue
		}
		uid, err := strconv.Atoi(fields[2])
		if err != nil {
			continue
		}
		entries = append(entries, passwdEntry{Name: fields[0], UID: uid, Home: fields[5]})
	}
	return entries, nil
}
