//go:build !linux

package kimi

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func privateDirectoryInUse(dir string) bool {
	raw, err := exec.Command("ps", "eww", "-U", strconv.Itoa(os.Getuid()), "-o", "command=").Output()
	if err != nil {
		return true
	}
	return strings.Contains(string(raw), "KIMI_CODE_HOME="+dir) || strings.Contains(string(raw), "KIMI_AUTH_PATH="+dir)
}

func waitPrivateDirectoryIdle(dir string) {
	for privateDirectoryInUse(dir) {
		time.Sleep(time.Second)
	}
}
