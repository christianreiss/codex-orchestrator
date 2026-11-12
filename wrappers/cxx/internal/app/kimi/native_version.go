package kimi

import (
	"context"
	"fmt"
	"os"

	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/kimi"
)

// Reject old installed binaries before syncing settings they cannot consume.
// Missing binaries still follow the existing fleet-target bootstrap path.
func (p *launchVersionProbe) requireInstalled(ctx context.Context) error {
	path, err := native.FindCLI()
	if err != nil {
		return nil
	}
	_, err = p.supported(ctx, path)
	return err
}

// Version evidence is local to a launch, never persisted across sessions. The
// early settings gate and final launch gate may share it only while the selected
// executable is unchanged (including atomic installs and symlink retargeting).
type launchVersionProbe struct {
	path    string
	info    os.FileInfo
	version string
}

func sameVersionExecutable(a, b os.FileInfo) bool {
	return a != nil && b != nil && os.SameFile(a, b) && a.Size() == b.Size() &&
		a.Mode() == b.Mode() && a.ModTime().Equal(b.ModTime())
}

// Script launchers can delegate to a separately updated executable. Only
// direct ELF/Mach-O binaries can reuse evidence from their own file metadata.
func directVersionExecutable(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var magic [4]byte
	if n, _ := f.Read(magic[:]); n != len(magic) {
		return false
	}
	switch string(magic[:]) {
	case "\x7fELF", "\xfe\xed\xfa\xce", "\xce\xfa\xed\xfe", "\xfe\xed\xfa\xcf", "\xcf\xfa\xed\xfe", "\xca\xfe\xba\xbe", "\xbe\xba\xfe\xca":
		return true
	}
	return false
}

func (p *launchVersionProbe) supported(ctx context.Context, path string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	before, _ := os.Stat(path)
	if path == p.path && sameVersionExecutable(before, p.info) {
		return p.version, nil
	}
	// Failed or changed executables must never inherit prior successful evidence.
	*p = launchVersionProbe{}
	cacheable := directVersionExecutable(path)
	version, err := native.ProbeVersion(ctx, path)
	if err != nil {
		return "", err
	}
	if !native.SupportedVersion(version) {
		return "", fmt.Errorf("Kimi %s is below the supported baseline %s; run ckx update or select a supported CKX_KIMI_BIN before launching", version, native.PinnedVersion)
	}
	after, _ := os.Stat(path)
	if cacheable && sameVersionExecutable(before, after) {
		*p = launchVersionProbe{path: path, info: after, version: version}
	}
	return version, nil
}
