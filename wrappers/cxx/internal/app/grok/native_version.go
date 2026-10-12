package grok

import (
	"context"
	"fmt"

	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
)

// Reject old installed binaries before syncing settings they cannot consume.
// Missing binaries still follow the existing fleet-target bootstrap path.
func requireSupportedNativeCLI(ctx context.Context) error {
	path, err := native.FindCLI()
	if err != nil {
		return nil
	}
	return requireSupportedNativeVersion(ctx, path)
}

func requireSupportedNativeVersion(ctx context.Context, path string) error {
	version, err := native.ProbeVersion(ctx, path)
	if err != nil {
		return err
	}
	if !native.SupportedVersion(version) {
		return fmt.Errorf("Grok %s is below the supported baseline %s; run cgx update or select a supported CGX_GROK_BIN before launching", version, native.PinnedVersion)
	}
	return nil
}
