package housekeeping

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

func nativeBusy(engine string) (bool, error) {
	if runtime.GOOS != "linux" {
		raw, err := exec.Command("ps", "-axo", "uid=,pid=,command=").Output()
		if err != nil {
			return false, err
		}
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 3 {
				continue
			}
			uid, _ := strconv.Atoi(fields[0])
			pid, _ := strconv.Atoi(fields[1])
			if uid == os.Getuid() && pid != os.Getpid() && nativeCommand(engine, strings.Join(fields[2:], " ")) {
				return true, nil
			}
		}
		return false, nil
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		p := filepath.Join("/proc", e.Name())
		st, err := os.Stat(p)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return false, err
		}
		info, ok := st.Sys().(*syscall.Stat_t)
		if !ok {
			return false, fmt.Errorf("cannot determine native process owner")
		}
		if info.Uid != uint32(os.Getuid()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(p, "cmdline"))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return false, err
		}
		if nativeCommand(engine, strings.ReplaceAll(string(raw), "\x00", " ")) {
			return true, nil
		}
	}
	return false, nil
}
func nativeCommand(engine, cmd string) bool {
	f := strings.Fields(cmd)
	if len(f) == 0 {
		return false
	}
	bin := filepath.Base(f[0])
	if bin == engine || strings.HasPrefix(bin, engine+"-") {
		return true
	}
	if engine == "claude" && (bin == "node" || strings.HasPrefix(bin, "node-")) {
		return strings.Contains(cmd, "claude-code") || strings.Contains(cmd, "/engines/claude/")
	}
	return false
}
