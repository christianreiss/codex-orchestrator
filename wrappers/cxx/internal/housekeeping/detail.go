package housekeeping

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Skip details name who defers housekeeping, so a cron.log "skipped" line is
// actionable: a live session, or an old orphaned leader the reaper removes.
// They read /proc and are empty where it is unavailable; they never decide
// anything, nativeBusy and the lock probes stay authoritative.

// nativeBusyDetail names up to three processes behind native_process_active.
func nativeBusyDetail(engine string) string {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return ""
	}
	var found []string
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		dir := filepath.Join("/proc", e.Name())
		st, err := os.Stat(dir)
		if err != nil {
			continue
		}
		if info, ok := st.Sys().(*syscall.Stat_t); !ok || info.Uid != uint32(os.Getuid()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, "cmdline"))
		if err != nil {
			continue
		}
		argv := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
		if !nativeArgv(engine, argv) {
			continue
		}
		desc := fmt.Sprintf("pid %d %s", pid, describeArgv(argv))
		if start := processStart(dir); !start.IsZero() {
			desc += " up " + time.Since(start).Truncate(time.Minute).String()
		}
		if found = append(found, desc); len(found) == 3 {
			break
		}
	}
	return strings.Join(found, ", ")
}

// describeArgv is the executable's base name plus up to two leading
// subcommand words ("grok agent leader"). Flags, values and prompts are never
// shown.
func describeArgv(argv []string) string {
	if len(argv) == 0 {
		return ""
	}
	out := filepath.Base(argv[0])
	for i, arg := range argv[1:] {
		if i == 2 || arg == "" || strings.HasPrefix(arg, "-") || strings.Trim(arg, "abcdefghijklmnopqrstuvwxyz-") != "" {
			break
		}
		out += " " + arg
	}
	return out
}

// processStart is a process's start time from /proc (zero if unknown).
func processStart(procDir string) time.Time {
	raw, err := os.ReadFile(filepath.Join(procDir, "stat"))
	if err != nil {
		return time.Time{}
	}
	i := strings.LastIndexByte(string(raw), ')')
	if i < 0 || i+2 > len(raw) {
		return time.Time{}
	}
	fields := strings.Fields(string(raw[i+2:]))
	if len(fields) < 20 {
		return time.Time{}
	}
	ticks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return time.Time{}
	}
	stat, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}
	}
	for _, line := range strings.Split(string(stat), "\n") {
		if rest, ok := strings.CutPrefix(line, "btime "); ok {
			secs, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
			if err != nil {
				return time.Time{}
			}
			return time.Unix(secs, 0).Add(time.Duration(ticks) * time.Second / 100)
		}
	}
	return time.Time{}
}

// lockHolders names the processes /proc/locks lists for path's inode.
func lockHolders(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	raw, err := os.ReadFile("/proc/locks")
	if err != nil {
		return ""
	}
	want := ":" + strconv.FormatUint(st.Ino, 10)
	var holders []string
	seen := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		f := strings.Fields(line)
		// "->" marks a blocked waiter, which holds nothing.
		if len(f) < 6 || f[1] == "->" || !strings.HasSuffix(f[5], want) || seen[f[4]] {
			continue
		}
		seen[f[4]] = true
		desc := "pid " + f[4]
		if cmd, err := os.ReadFile(filepath.Join("/proc", f[4], "cmdline")); err == nil && len(cmd) > 0 {
			desc += " " + describeArgv(strings.Split(strings.TrimRight(string(cmd), "\x00"), "\x00"))
		}
		if holders = append(holders, desc); len(holders) == 3 {
			break
		}
	}
	if len(holders) == 0 {
		return ""
	}
	return "held by " + strings.Join(holders, ", ")
}
