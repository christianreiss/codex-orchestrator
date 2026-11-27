//go:build windows

package lifecycle

import "errors"

// restrictConfigMode cannot remove group/world access here: os.Chmod only
// toggles the read-only attribute, so reporting success would be a lie.
// windows: no mode-bit privacy for config.toml (needs an ACL), tracked in docs/reports/platform-feasibility-2026-11-27.md
func restrictConfigMode(path string) error {
	return errors.New("not supported on windows: restricting config.toml to its owner")
}
