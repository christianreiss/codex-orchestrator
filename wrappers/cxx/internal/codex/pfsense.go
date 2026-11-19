package codex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const pilotVersion = "0.167.0"

// Only packages checked against this appliance image enter its private prefix.
// Digests originate in the fingerprint-signed FreeBSD package catalogue.
type portFile struct{ member, dest string }
type pilotPort struct {
	name, sha string
	files     []portFile
}

var pilotPorts = []pilotPort{
	{"codex-0.167.0~2$ibesqrb8.pkg", "9879e85cf158a3dc8ad49b9fed1e159bd3283d8feb364591e1a269c0dc791e70", []portFile{
		{"bin/codex", "codex.bin"}, {"bin/codex-code-mode-host", "codex-code-mode-host.bin"},
		{"share/licenses/codex-0.167.0/LICENSE", "codex.LICENSE"}}},
	{"dbus-1.16.4,1~2$p7kxnngj.pkg", "03c1e5544cbc398b5ef67404ccd6d7b11a83195b5d93c73512e452730b9b00e9", []portFile{{"lib/libdbus-1.so.3.38.5", "lib/libdbus-1.so.3"}}},
	{"oniguruma-6.9.10~2$x7zq1suf.pkg", "69e7e98af1665e2d07f8fb6c6852948a6022f3ca8ef4c4ca7502eeab15399985", []portFile{{"lib/libonig.so.5.5.0", "lib/libonig.so.5"}}},
	{"ripgrep-15.2.0_2~2$qsshzdio.pkg", "72163acc292b9e7f6ac53c6b609efeef3b8666b752d68c9133cf755067eb0bf8", []portFile{{"bin/rg", "rg"}}},
}

func releaseForPlatform(ctx context.Context, target string) (Release, error) {
	if runtime.GOOS != "freebsd" {
		return releaseForReconcile(ctx, target)
	}
	product, err := os.ReadFile("/etc/product_name")
	if err != nil || strings.TrimSpace(string(product)) != "pfSense" || runtime.GOARCH != "amd64" {
		return Release{}, errors.New("native Codex pilot requires pfSense CE amd64")
	}
	version, err := os.ReadFile("/etc/version")
	if err != nil || strings.TrimSpace(string(version)) != "2.9.0-RELEASE" {
		return Release{}, errors.New("native Codex pilot requires pfSense CE 2.9.0")
	}
	abi, err := exec.CommandContext(ctx, "/sbin/sysctl", "-n", "kern.osreldate").Output()
	if err != nil || strings.TrimSpace(string(abi)) != "1600018" {
		return Release{}, errors.New("native Codex pilot requires FreeBSD OSVERSION 1600018")
	}
	requested := strings.TrimPrefix(strings.TrimPrefix(target, "rust-"), "v")
	if requested != "" && requested != "latest" && requested != pilotVersion {
		return Release{}, fmt.Errorf("pfSense CE pilot provides Codex %s, host requested %s", pilotVersion, target)
	}
	return Release{TagName: "rust-v" + pilotVersion}, nil
}

// Execute the ELF directly so current_exe identifies the embedded client,
// and scope the library mappings to that image so its tools use system libraries.
const pfSenseCodexLauncher = `#!/bin/sh
dir=${0%/*}
PATH="$dir:$PATH"; export PATH
export LD_LIBMAP="${LD_LIBMAP:+$LD_LIBMAP
}[$dir/codex.bin]
libdbus-1.so.3 $dir/lib/libdbus-1.so.3
libonig.so.5 $dir/lib/libonig.so.5"
exec "$dir/codex.bin" "$@"
`

func installPfSensePort(ctx context.Context, dir string) error {
	if strings.ContainsAny(dir, " \t\r\n,=[]#") {
		return fmt.Errorf("pfSense engine prefix contains characters unsupported by FreeBSD LD_LIBMAP: %q", dir)
	}
	if err := os.Mkdir(filepath.Join(dir, "lib"), 0700); err != nil {
		return err
	}
	archive := filepath.Join(dir, "port.pkg")
	defer os.Remove(archive)
	for _, port := range pilotPorts {
		if err := downloadFile(ctx, "https://pkg.freebsd.org/FreeBSD:16:amd64/latest/All/Hashed/"+port.name, archive); err != nil {
			return err
		}
		hash, err := sha256File(archive)
		if err != nil {
			return err
		}
		if hash != port.sha {
			return fmt.Errorf("FreeBSD package %s: SHA-256 mismatch", port.name)
		}
		for _, file := range port.files {
			out, err := os.OpenFile(filepath.Join(dir, file.dest), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
			if err != nil {
				return err
			}
			// Explicit members streamed to caller-created files: pkg scripts and archive
			// paths never execute or modify the appliance package database.
			cmd := exec.CommandContext(ctx, "/usr/bin/tar", "-xOf", archive, "/usr/local/"+file.member)
			cmd.Stdout = out
			if err := errors.Join(cmd.Run(), out.Close()); err != nil {
				return fmt.Errorf("extract %s: %w", file.member, err)
			}
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte(pfSenseCodexLauncher), 0700); err != nil {
		return err
	}
	// The companion is a leaf process and can keep the per-image loader path.
	companionLauncher := "#!/bin/sh\ndir=${0%/*}\nexec /libexec/ld-elf.so.1 -o \"LIBRARY_PATH=$dir/lib\" \"$dir/" + codeModeHostBinName + ".bin\" \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, codeModeHostBinName), []byte(companionLauncher), 0700); err != nil {
		return err
	}
	if err := exec.CommandContext(ctx, filepath.Join(dir, "rg"), "--version").Run(); err != nil {
		return fmt.Errorf("pfSense ripgrep probe: %w", err)
	}
	return os.WriteFile(filepath.Join(dir, standaloneReceipt), []byte("v1\n"), 0600)
}

// The old launcher reports the right version but cannot start Code Mode.
func pfSensePortFilesHealthy(cli string) bool {
	launcher, err := os.ReadFile(cli)
	if err != nil || string(launcher) != pfSenseCodexLauncher {
		return false
	}
	dir := filepath.Dir(cli)
	for _, port := range pilotPorts {
		for _, file := range port.files {
			if !regularFile(filepath.Join(dir, file.dest), true) {
				return false
			}
		}
	}
	return true
}
