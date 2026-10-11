package codex

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeprocess/testutil"
	"path/filepath"
	"testing"
)

func TestNativeCancellationAllowsTermHandler(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", filepath.Join(t.TempDir(), ".codex"))
	testutil.Cancellation(t, func(ctx context.Context, path string) (int, error) {
		t.Setenv("CDX_CODEX_BIN", path)
		code, _, err := RunCapturePrepared(ctx, &config.Config{Host: config.Host{Secure: true}}, nil)
		return code, err
	})
}
