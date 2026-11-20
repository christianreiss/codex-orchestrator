//go:build !linux

package privatehome

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func (s *Spec) inUse(dir string) bool {
	raw, err := exec.Command("ps", "eww", "-U", strconv.Itoa(os.Getuid()), "-o", "command=").Output()
	if err != nil {
		return true
	}
	for _, key := range s.EnvKeys {
		if strings.Contains(string(raw), key+"="+dir) {
			return true
		}
	}
	return false
}

func (s *Spec) waitIdle(dir string) {
	for s.inUse(dir) {
		time.Sleep(time.Second)
	}
}
