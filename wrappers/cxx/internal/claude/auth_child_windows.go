//go:build windows

package claude

import (
	"fmt"
	"os"
)

// windows: no dup(2) lease handoff to the native child, tracked in docs/reports/platform-feasibility-2026-11-27.md
func duplicateLeaseFile(f *os.File, name string) (*os.File, error) {
	return nil, fmt.Errorf("not supported on windows: duplicating the %s lease", name)
}
