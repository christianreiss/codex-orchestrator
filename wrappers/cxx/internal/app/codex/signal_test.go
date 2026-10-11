package codexapp

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeprocess/testutil"
	"io"
	"path/filepath"
	"testing"
)

func TestNativeCancellationAllowsTermHandler(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", filepath.Join(t.TempDir(), ".codex"))
	testutil.Cancellation(t, func(ctx context.Context, path string) (int, error) {
		code, _, err := runHelpChild(ctx, path, nil, io.Discard, io.Discard)
		return code, err
	})
}
