//go:build windows

package nativeentry

import "errors"

// windows: no POSIX uid to compare the home directory owner against, tracked in docs/reports/platform-feasibility-2026-11-27.md
func checkHomeOwner(home string) error {
	return errors.New("not supported on windows: home directory owner check")
}
