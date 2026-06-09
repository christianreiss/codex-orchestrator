package claude

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
)

func Version(ctx context.Context) string {
	cli, err := FindCLI()
	if err != nil {
		return "unknown"
	}
	for _, flag := range []string{"--version", "-V"} {
		cmd := exec.CommandContext(ctx, cli, flag)
		var out bytes.Buffer
		cmd.Stdout = &out
		cmd.Stderr = &out
		if err := cmd.Run(); err == nil {
			s := strings.TrimSpace(out.String())
			if s != "" {
				parts := strings.Fields(s)
				if len(parts) >= 2 && (strings.EqualFold(parts[0], "claude") || strings.EqualFold(parts[0], "claude-code")) {
					return parts[1]
				}
				return s
			}
		}
	}
	return "unknown"
}
