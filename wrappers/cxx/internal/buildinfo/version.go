// Package buildinfo exposes the running artifact's capabilities to HTTP clients.
package buildinfo

import (
	"strconv"
	"strings"
)

// Version is initialized once by main, before any clients or workers start.
// Signed config versions describe a target and must not substitute for this.
var Version = "dev"

// Release reports whether the running binary is a versioned build. Every
// artifact the bakery serves, and every `make` build, is stamped with
// MAJOR.MINOR.PATCH through -ldflags; a plain `go build` keeps "dev". The
// difference does not depend on where the binary lives, so an update that
// replaces /usr/local/bin/cxx or ~/.local/bin/cxx with a new release is still
// a release, while a throwaway build in a scratch directory never is.
func Release() bool {
	base := strings.TrimPrefix(strings.TrimSpace(Version), "v")
	if i := strings.IndexAny(base, "+-"); i >= 0 {
		base = base[:i]
	}
	parts := strings.Split(base, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if n, err := strconv.Atoi(part); err != nil || n < 0 || part == "" {
			return false
		}
	}
	return true
}
