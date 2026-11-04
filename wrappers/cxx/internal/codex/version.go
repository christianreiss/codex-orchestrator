package codex

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
)

var versionTokenRE = regexp.MustCompile(`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`)

var installedVersion struct {
	sync.Mutex
	path  string
	info  os.FileInfo
	value string
}

func sameVersionFile(a, b os.FileInfo) bool {
	return a != nil && b != nil && os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime() == b.ModTime() && a.Mode() == b.Mode()
}

// Only direct native executables can be identified by their own file metadata.
// A script (including npm's launcher) may delegate to a separately updated file.
func nativeVersionFile(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var magic [4]byte
	if n, _ := f.Read(magic[:]); n != len(magic) {
		return false
	}
	switch string(magic[:]) {
	case "\x7fELF", "\xfe\xed\xfa\xce", "\xce\xfa\xed\xfe", "\xfe\xed\xfa\xcf", "\xcf\xfa\xed\xfe", "\xca\xfe\xba\xbe", "\xbe\xba\xfe\xca":
		return true
	}
	return false
}

// Version invokes `codex -V` (or `--version`) and returns the parsed string.
// Successful native executable probes are reused within this process while the
// selected file is unchanged. Failures and indirect launchers are never cached.
// Returns "unknown" if the CLI isn't installed.
func Version(ctx context.Context) string {
	if ctx.Err() != nil {
		return "unknown"
	}
	cli, err := FindCLI()
	if err != nil {
		return "unknown"
	}
	info, _ := os.Stat(cli)
	installedVersion.Lock()
	if installedVersion.path == cli && sameVersionFile(installedVersion.info, info) {
		value := installedVersion.value
		installedVersion.Unlock()
		return value
	}
	installedVersion.Unlock()
	cacheable := nativeVersionFile(cli)
	for _, flag := range []string{"-V", "--version"} {
		cmd := exec.CommandContext(ctx, cli, flag)
		var out bytes.Buffer
		cmd.Stdout = &out
		cmd.Stderr = &out
		if err := cmd.Run(); err == nil {
			s := strings.TrimSpace(out.String())
			if s != "" {
				if v := versionTokenRE.FindString(s); v != "" {
					if after, err := os.Stat(cli); cacheable && err == nil && sameVersionFile(info, after) {
						installedVersion.Lock()
						installedVersion.path, installedVersion.info, installedVersion.value = cli, after, v
						installedVersion.Unlock()
					}
					return v
				}
				return s
			}
		}
	}
	return "unknown"
}
