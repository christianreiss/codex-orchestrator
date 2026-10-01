package grok

import (
	"bytes"
	"context"
	"debug/elf"
	"debug/macho"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Opt-in verification of the actual four pinned registry artifacts. Normal
// unit/race runs remain offline; no package script is executed in this check.
func TestGrokRegistryPackagesCanary(t *testing.T) {
	if os.Getenv("CGX_NATIVE_REGISTRY_CANARY") != "1" {
		t.Skip("registry canary requires explicit opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	client := &http.Client{Timeout: time.Minute}
	for _, platform := range []struct{ os, arch string }{{"linux", "amd64"}, {"linux", "arm64"}, {"darwin", "amd64"}, {"darwin", "arm64"}} {
		t.Run(platform.os+"-"+platform.arch, func(t *testing.T) {
			pkg, err := PlatformPackage(platform.os, platform.arch)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := download(ctx, client, "https://registry.npmjs.org/"+url.PathEscape(pkg)+"/"+PinnedVersion, 1<<20)
			if err != nil {
				t.Fatal(err)
			}
			var meta packageMetadata
			if json.Unmarshal(raw, &meta) != nil || meta.Version != PinnedVersion {
				t.Fatal("pinned registry version mismatch")
			}
			origin, err := url.Parse(meta.Dist.Tarball)
			if err != nil || origin.Scheme != "https" || origin.Host != "registry.npmjs.org" {
				t.Fatal("untrusted tarball origin")
			}
			archive, err := download(ctx, client, meta.Dist.Tarball, 300<<20)
			if err != nil {
				t.Fatal(err)
			}
			binary, err := ExtractBinary(archive, meta.Dist.Integrity)
			if err != nil {
				t.Fatal(err)
			}
			if platform.os == "linux" {
				f, err := elf.NewFile(bytes.NewReader(binary))
				if err != nil {
					t.Fatal(err)
				}
				want := elf.EM_X86_64
				if platform.arch == "arm64" {
					want = elf.EM_AARCH64
				}
				if f.Machine != want {
					t.Fatal("Linux artifact architecture mismatch")
				}
			} else {
				f, err := macho.NewFile(bytes.NewReader(binary))
				if err != nil {
					t.Fatal(err)
				}
				want := macho.CpuAmd64
				if platform.arch == "arm64" {
					want = macho.CpuArm64
				}
				if f.Cpu != want {
					t.Fatal("Darwin artifact architecture mismatch")
				}
			}
			if platform.os == "linux" && platform.arch == "amd64" {
				path := filepath.Join(t.TempDir(), "grok")
				if err := os.WriteFile(path, binary, 0o700); err != nil {
					t.Fatal(err)
				}
				if version, err := ProbeVersion(ctx, path); err != nil || version != PinnedVersion {
					t.Fatal("real native binary version mismatch")
				}
			}
			t.Logf("%s@%s: sha512/Brotli and native architecture verified (%d bytes)", pkg, meta.Version, len(binary))
		})
	}
}
