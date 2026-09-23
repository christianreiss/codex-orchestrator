package terminalui

import (
	"fmt"
	"io"
	"runtime"
)

// BuildInfo is the link-time identity shared by cxx, cdx and clx.
type BuildInfo struct {
	Name       string
	Version    string
	Commit     string
	BuildDate  string
	SigningKey bool
}

// PrintVersion renders --version identically for every persona. It stays
// plain text on purpose: installers and support scripts parse this output.
func PrintVersion(w io.Writer, b BuildInfo) {
	fmt.Fprintf(w, "%s %s (commit %s, built %s, %s/%s)\n", b.Name, b.Version, b.Commit, b.BuildDate, runtime.GOOS, runtime.GOARCH)
	if b.SigningKey {
		fmt.Fprintln(w, "signing pubkey: embedded")
	} else {
		fmt.Fprintln(w, "signing pubkey: MISSING (this binary refuses signed configs)")
	}
}
