//go:build linux

package workload

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type memoryView struct{ available, capacity, swapFree uint64 }

func readMemory(proc, cgroup string) (memoryView, error) {
	raw, err := os.ReadFile(filepath.Join(proc, "meminfo"))
	if err != nil {
		return memoryView{}, err
	}
	fields := map[string]uint64{}
	for _, line := range strings.Split(string(raw), "\n") {
		f := strings.Fields(line)
		if len(f) != 3 || f[2] != "kB" {
			continue
		}
		n, e := strconv.ParseUint(f[1], 10, 64)
		if e != nil || n > ^uint64(0)/1024 {
			return memoryView{}, fmt.Errorf("invalid memory observation")
		}
		fields[strings.TrimSuffix(f[0], ":")] = n * 1024
	}
	v := memoryView{available: fields["MemAvailable"], capacity: fields["MemTotal"], swapFree: fields["SwapFree"]}
	if v.capacity == 0 {
		return v, fmt.Errorf("MemTotal unavailable")
	}
	if _, ok := fields["MemAvailable"]; !ok {
		return v, fmt.Errorf("MemAvailable unavailable")
	}
	v.available = min(v.available, v.capacity)
	raw, err = os.ReadFile(filepath.Join(proc, "self/cgroup"))
	if err != nil {
		return v, err
	}
	group := ""
	for _, line := range strings.Split(string(raw), "\n") {
		f := strings.SplitN(line, ":", 3)
		if len(f) != 3 {
			continue
		}
		if f[0] == "0" && f[1] == "" {
			group = f[2]
		}
		if strings.Contains(","+f[1]+",", ",memory,") {
			return v, fmt.Errorf("cgroup v1 memory accounting is unsupported; admission refused")
		}
	}
	if group == "" {
		return v, fmt.Errorf("cgroup v2 location unavailable; admission refused")
	}
	if !filepath.IsAbs(group) || filepath.Clean(group) != group {
		return v, fmt.Errorf("invalid cgroup location; admission refused")
	}
	// Resolve the process's cgroup relative to the mounted hierarchy. A namespace
	// can expose a subtree rather than /. Unresolvable constraints fail closed.
	raw, err = os.ReadFile(filepath.Join(proc, "self/mountinfo"))
	if err != nil {
		return v, err
	}
	root := ""
	for _, line := range strings.Split(string(raw), "\n") {
		p := strings.SplitN(line, " - ", 2)
		if len(p) != 2 || !strings.HasPrefix(p[1], "cgroup2 ") {
			continue
		}
		f := strings.Fields(p[0])
		if len(f) < 5 {
			continue
		}
		mountRoot := unescapeMount(f[3])
		mountPoint := unescapeMount(f[4])
		if mountPoint != cgroup {
			continue
		}
		if group == mountRoot {
			root = cgroup
		} else if strings.HasPrefix(group, strings.TrimRight(mountRoot, "/")+"/") {
			root = filepath.Join(cgroup, strings.TrimPrefix(group, strings.TrimRight(mountRoot, "/")+"/"))
		}
	}
	if root == "" {
		return v, fmt.Errorf("cgroup v2 mount unavailable; admission refused")
	}
	for dir := root; ; dir = filepath.Dir(dir) {
		maxRaw, e := os.ReadFile(filepath.Join(dir, "memory.max"))
		if e != nil {
			// The root hierarchy has no memory.max. Every constrained child must.
			if dir != cgroup || !os.IsNotExist(e) {
				return v, fmt.Errorf("cgroup memory limit unavailable: %w", e)
			}
		} else if strings.TrimSpace(string(maxRaw)) != "max" {
			limit, e := strconv.ParseUint(strings.TrimSpace(string(maxRaw)), 10, 64)
			if e != nil {
				return v, fmt.Errorf("invalid cgroup memory limit")
			}
			usedRaw, e := os.ReadFile(filepath.Join(dir, "memory.current"))
			if e != nil {
				return v, e
			}
			used, e := strconv.ParseUint(strings.TrimSpace(string(usedRaw)), 10, 64)
			if e != nil {
				return v, fmt.Errorf("invalid cgroup memory usage")
			}
			headroom := uint64(0)
			if limit > used {
				headroom = limit - used
			}
			v.available = min(v.available, headroom)
			v.capacity = min(v.capacity, limit)
		}
		if dir == cgroup {
			break
		}
		if !strings.HasPrefix(dir, cgroup+string(filepath.Separator)) {
			return v, fmt.Errorf("invalid cgroup path")
		}
	}
	return v, nil
}

func unescapeMount(s string) string {
	r := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	return r.Replace(s)
}

func usable(v memoryView, reserved, reserve uint64) uint64 {
	if reserve == 0 {
		reserve = max(256<<20, v.capacity/10)
	}
	if v.available <= reserve || v.available-reserve <= reserved {
		return 0
	}
	return v.available - reserve - reserved
}
