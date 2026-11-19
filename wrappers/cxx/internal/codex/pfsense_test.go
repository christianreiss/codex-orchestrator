package codex

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPfSenseRejectsPreviousLauncherAtSameClientVersion(t *testing.T) {
	dir := t.TempDir()
	write := func(path, body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0700); err != nil {
			t.Fatal(err)
		}
	}

	if err := os.Mkdir(filepath.Join(dir, "lib"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, port := range pilotPorts {
		for _, file := range port.files {
			write(filepath.Join(dir, file.dest), "fixture")
		}
	}
	launcher := filepath.Join(dir, "codex")
	write(launcher, "#!/bin/sh\nexec /libexec/ld-elf.so.1 codex.bin \"$@\"\n")
	if pfSensePortFilesHealthy(launcher) {
		t.Fatal("accepted old loader-based launcher")
	}
	write(launcher, pfSenseCodexLauncher)
	if !pfSensePortFilesHealthy(launcher) {
		t.Fatal("rejected current launcher with complete private port")
	}
	if err := os.Remove(filepath.Join(dir, "codex-code-mode-host.bin")); err != nil {
		t.Fatal(err)
	}
	if pfSensePortFilesHealthy(launcher) {
		t.Fatal("accepted a missing Code Mode host binary")
	}
}
