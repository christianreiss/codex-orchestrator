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
		if nativeArgv(engine, strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")) {
			return true, nil
		}
	}
	return false, nil
}
func nativeCommand(engine, cmd string) bool {
	// ps lacks argv boundaries. Preserve a native executable path containing
	// spaces when possible; otherwise conservatively inspect its words.
	f := strings.Fields(cmd)
	for n := 1; n <= len(f); n++ {
		if nativeExecutable(engine, strings.Join(f[:n], " ")) {
			return true
		}
	}
	return nativeArgv(engine, f)
}

func nativeExecutable(engine, path string) bool {
	bin := filepath.Base(path)
	return bin == engine || strings.HasPrefix(bin, engine+"-") ||
		engine == "claude" && (strings.Contains(path, "/claude-code/") || strings.Contains(path, "/engines/claude/"))
}

func nativeArgv(engine string, argv []string) bool {
	if len(argv) == 0 || argv[0] == "" {
		return false
	}
	if nativeExecutable(engine, argv[0]) {
		return true
	}
	bin := filepath.Base(argv[0])
	if bin == "env" {
		for i := 1; i < len(argv); i++ {
			arg := argv[i]
			if arg == "-u" || arg == "--unset" || arg == "-C" || arg == "--chdir" {
				i++
				continue
			}
			if strings.HasPrefix(arg, "-") || strings.Contains(arg, "=") {
				continue
			}
			return nativeArgv(engine, argv[i:])
		}
	}
	if bin == "sh" || bin == "bash" || bin == "dash" || bin == "zsh" || bin == "node" || strings.HasPrefix(bin, "node-") {
		for _, arg := range argv[1:] {
			// -c/-e code and ordinary prompt arguments are not script paths.
			if arg == "-c" || arg == "-e" || arg == "--eval" || arg == "-p" || arg == "--print" {
				return false
			}
			if !strings.HasPrefix(arg, "-") {
				return nativeExecutable(engine, arg)
			}
		}
	}
	return false
}
