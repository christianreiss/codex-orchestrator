//go:build windows

package main

// updaterTargetWritable reports false, so the communicator never schedules a
// self-update on the strength of a check this platform cannot make.
// windows: no access(2) W_OK probe for the update target, tracked in docs/reports/platform-feasibility-2026-11-27.md
func updaterTargetWritable(path string) bool { return false }
