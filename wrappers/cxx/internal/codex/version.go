package codex

import (
	"bytes"
	"context"
	"os/exec"
	"regexp"
	"strings"
)

var versionTokenRE = regexp.MustCompile(`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`)

// Version invokes `codex -V` (or `--version`) and returns the parsed string.
// Returns "unknown" if the CLI isn't installed.
func Version(ctx context.Context) string {
	cli, err := FindCLI()
	if err != nil {
		return "unknown"
	}
	for _, flag := range []string{"-V", "--version"} {
		cmd := exec.CommandContext(ctx, cli, flag)
		var out bytes.Buffer
		cmd.Stdout = &out
		cmd.Stderr = &out
		if err := cmd.Run(); err == nil {
			s := strings.TrimSpace(out.String())
			if s != "" {
				if v := versionTokenRE.FindString(s); v != "" {
					return v
				}
				return s
			}
		}
	}
	return "unknown"
}
