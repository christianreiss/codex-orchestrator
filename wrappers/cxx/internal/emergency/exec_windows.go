//go:build windows

package emergency

import "errors"

// windows: no exec(2) process replacement, tracked in docs/reports/platform-feasibility-2026-11-27.md
func execNative(path string, argv, env []string) (int, error) {
	return 1, errors.New("not supported on windows: replacing the wrapper with the native CLI")
}
