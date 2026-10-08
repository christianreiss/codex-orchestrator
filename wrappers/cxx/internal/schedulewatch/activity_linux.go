//go:build linux

package schedulewatch

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

type processActivity struct {
	known bool
	cpu   uint64
	tool  bool
}

func activity(pid int) processActivity {
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return processActivity{}
	}
	parts := strings.Fields(string(raw)[strings.LastIndex(string(raw), ")")+1:])
	if len(parts) < 13 {
		return processActivity{}
	}
	u, _ := strconv.ParseUint(parts[11], 10, 64)
	s, _ := strconv.ParseUint(parts[12], 10, 64)
	result := processActivity{known: true, cpu: u + s}
	// A quiet child tool is real ongoing work, not an output timeout. MCP servers
	// themselves do not count; their actual child commands do. Walk only kernel-
	// reported descendants of the process we created.
	var descend func(int, int)
	descend = func(parent, depth int) {
		if depth > 8 {
			return
		}
		tasks, _ := filepath.Glob(filepath.Join("/proc", strconv.Itoa(parent), "task", "*", "children"))
		seen := map[int]bool{}
		for _, task := range tasks {
			children, _ := os.ReadFile(task)
			for _, id := range strings.Fields(string(children)) {
				child, _ := strconv.Atoi(id)
				if child <= 0 || seen[child] {
					continue
				}
				seen[child] = true
				command, _ := os.ReadFile(filepath.Join("/proc", id, "cmdline"))
				text := strings.ReplaceAll(string(command), "\x00", " ")
				// cxx MCP, runtime accessors and the shared Codex app-server are adapters;
				// a subprocess below them (sleep/build/test/ssh/etc.) still counts as work.
				adapter := strings.Contains(text, "agent mcp") || strings.Contains(text, "app-server") || strings.Contains(text, "auth-accessor")
				if !adapter && !strings.Contains(text, "cxx") {
					result.tool = true
				}
				descend(child, depth+1)
			}
		}
	}
	descend(pid, 0)
	return result
}
func terminate(p *os.Process) error { return p.Signal(syscall.SIGTERM) }
