//go:build !linux

package enginestore

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// inUse is best-effort off Linux: there is no /proc, so the process list is
// matched on argv[0]. An engine launched through a relative path would be
// missed; the prefix is then swept a tick early. Nothing here deletes a prefix
// the pointer still selects, so the blast radius stays a stale session.
func inUse(dir string) bool {
	prefix := strings.TrimSuffix(dir, string(os.PathSeparator)) + string(os.PathSeparator)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-Ao", "args=").Output()
	if err != nil {
		// Same reasoning as the Linux fallback: unproven means busy.
		return true
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), prefix) {
			return true
		}
	}
	return false
}
