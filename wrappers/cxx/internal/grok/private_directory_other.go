//go:build !linux

package grok

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
	return strings.Contains(string(raw), "GROK_HOME="+dir) || strings.Contains(string(raw), "GROK_AUTH_PATH="+dir)
}

func waitPrivateDirectoryIdle(dir string) {
	for privateDirectoryInUse(dir) {
		time.Sleep(time.Second)
	}
}
