package claude

import (
	"bytes"
	"context"
	"os/exec"
	"regexp"
	"strings"
)

var versionTokenRE = regexp.MustCompile(`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`)

func Version(ctx context.Context) string {
	cli, err := FindCLI()
	if err != nil {
		return "unknown"
	}
	return versionFromCLI(ctx, cli)
}

func versionFromCLI(ctx context.Context, cli string) string {
	for _, flag := range []string{"--version", "-V"} {
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
