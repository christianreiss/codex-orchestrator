package agentbus

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestUnmanagedWorkerCancellationStopsWrapperAndNativeChild(t *testing.T) {
	old := startNativeCommand
	t.Cleanup(func() { startNativeCommand = old })
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CXX_WORKER_TEST_DIR", dir)
			path := filepath.Join(dir, "wrapper")
			script := `#!/bin/sh
if [ "$1" = native ]; then
 trap 'echo caught > "$CXX_WORKER_TEST_DIR/native-stopped"; exit 0' TERM
 : > "$CXX_WORKER_TEST_DIR/ready"
 while :; do sleep 0.02; done
else
 "$0" native &
 child=$!
 trap 'wait "$child"; echo caught > "$CXX_WORKER_TEST_DIR/wrapper-stopped"; exit 0' TERM
 wait "$child"
fi
`
			if err := os.WriteFile(path, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			startNativeCommand = func(cmd *exec.Cmd) error {
				cmd.Path, cmd.Args = path, []string{path}
				return cmd.Start()
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan nativeResult, 1)
			go func() {
				done <- (&relayClient{}).runNative(ctx, &config.Config{}, &relayDelivery{Target: map[string]any{"engine": engine, "cwd": dir}}, "", true)
			}()
			deadline := time.Now().Add(3 * time.Second)
			for {
				if _, err := os.Stat(filepath.Join(dir, "ready")); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("native fixture did not start")
				}
				time.Sleep(10 * time.Millisecond)
			}
			cancel()
			select {
			case result := <-done:
				if !result.Started || result.Err == nil {
					t.Fatalf("cancelled work reported success: %+v", result)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("worker did not finish bounded graceful cleanup")
			}
			for _, name := range []string{"native-stopped", "wrapper-stopped"} {
				if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
					t.Fatalf("%s did not finish before worker returned: %v", name, err)
				}
			}
		})
	}
}
