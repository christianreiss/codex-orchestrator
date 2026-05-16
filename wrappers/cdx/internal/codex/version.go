package codex

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
)

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
				// Trim "codex 0.4.2" -> "0.4.2" if the binary prints a label.
				parts := strings.Fields(s)
				if len(parts) >= 2 && strings.EqualFold(parts[0], "codex") {
					return strings.Join(parts[1:], " ")
				}
				return s
			}
		}
	}
	return "unknown"
}
