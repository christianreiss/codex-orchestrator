package claude

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeprocess/testutil"
	"io"
	"os"
	"testing"
)

func TestNativeCancellationAllowsTermHandler(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	testutil.Cancellation(t, func(ctx context.Context, path string) (int, error) {
		t.Setenv("CLX_CLAUDE_BIN", path)
		code, _, err := RunCapture(ctx, &config.Config{}, nil)
		return code, err
	})
}

func TestHelpCancellationAllowsTermHandler(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	testutil.Cancellation(t, func(ctx context.Context, path string) (int, error) {
		return RunHelpPassthrough(ctx, path, []string{path, "--help"}, os.Environ(), nil, io.Discard, io.Discard, nil)
	})
}
