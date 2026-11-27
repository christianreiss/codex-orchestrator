//go:build windows

package installspace

import "errors"

// Inspect cannot report a device identity comparable across paths here, so
// installer space accounting refuses instead of guessing.
// windows: no statfs/st_dev free-space and device probe, tracked in docs/reports/platform-feasibility-2026-11-27.md
func Inspect(path string) (Capacity, error) {
	return Capacity{}, errors.New("not supported on windows: install space inspection")
}
