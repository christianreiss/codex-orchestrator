package grok

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeprocess/testutil"
	"io"
	"os"
	"testing"
)

func TestNativeCancellationAllowsTermHandler(t *testing.T) {
	testutil.Cancellation(t, func(ctx context.Context, path string) (int, error) {
		return execute(ctx, path, nil, os.Environ(), io.Discard, io.Discard), nil
	})
}
