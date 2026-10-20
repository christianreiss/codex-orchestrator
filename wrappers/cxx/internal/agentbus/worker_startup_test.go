package agentbus

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeFailureReportsOnlyStructuredStartupEvidence(t *testing.T) {
	old := startNativeCommand
	t.Cleanup(func() { startNativeCommand = old })
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "wrapper")
			if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s' '{\"stage\":\"registration\",\"code\":\"agent_messaging_lease_lost\",\"status\":409}' > \"$CXX_NATIVE_STARTUP_FAILURE_PATH\"\nprintf '%s' 'private-token-and-prompt' >&2\nexit 1\n"), 0700); err != nil {
				t.Fatal(err)
			}
			diagnosticPath := ""
			startNativeCommand = func(cmd *exec.Cmd) error {
				for _, entry := range cmd.Env {
					if strings.HasPrefix(entry, agentportal.StartupFailureEnv+"=") {
						diagnosticPath = strings.TrimPrefix(entry, agentportal.StartupFailureEnv+"=")
					}
				}
				cmd.Path, cmd.Args = path, []string{path}
				return cmd.Start()
			}
			result := (&relayClient{}).runNative(context.Background(), &config.Config{}, &relayDelivery{Target: map[string]any{"engine": engine, "cwd": dir}}, "", true)
			if !result.Started || result.Err == nil || !strings.Contains(result.Err.Error(), "startup stage=registration code=agent_messaging_lease_lost http=409") || strings.Contains(result.Err.Error(), "private-token") {
				t.Fatalf("%+v", result)
			}
			if _, err := os.Stat(diagnosticPath); !os.IsNotExist(err) {
				t.Fatal("diagnostic not cleaned", err)
			}
		})
	}
}
