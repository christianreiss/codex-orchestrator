package grok

import (
	"strings"
	"testing"
)

func TestPlatformPackageWindows(t *testing.T) {
	for _, tt := range []struct {
		os, arch, pkg string
		wantErr       bool
	}{
		{"windows", "amd64", "@xai-official/grok-win32-x64", false},
		{"windows", "arm64", "@xai-official/grok-win32-arm64", false},
		{"windows", "386", "", true},
		{"freebsd", "amd64", "", true},
		{"linux", "amd64", "@xai-official/grok-linux-x64", false},
		{"darwin", "arm64", "@xai-official/grok-darwin-arm64", false},
	} {
		got, err := PlatformPackage(tt.os, tt.arch)
		if (err != nil) != tt.wantErr || got != tt.pkg {
			t.Errorf("%s/%s = %q, %v; want %q (err=%v)", tt.os, tt.arch, got, err, tt.pkg, tt.wantErr)
		}
	}
}

func TestBinaryNamesPerOS(t *testing.T) {
	for goos, want := range map[string][2]string{
		"windows": {"grok.exe", "package/bin/grok.exe.br"},
		"linux":   {"grok", "package/bin/grok.br"},
		"darwin":  {"grok", "package/bin/grok.br"},
	} {
		if binaryName(goos) != want[0] || archiveMember(goos) != want[1] {
			t.Errorf("%s: %q %q, want %v", goos, binaryName(goos), archiveMember(goos), want)
		}
	}
}

func TestExtractBinaryForWindows(t *testing.T) {
	pe := []byte("MZ\x90\x00 windows executable fixture")

	data, integrity := archiveFixture(t, pe, "package/bin/grok.exe.br")
	got, err := ExtractBinaryFor("windows", data, integrity)
	if err != nil || string(got) != string(pe) {
		t.Fatalf("windows extract = %q, %v", got, err)
	}

	// Wrong member names: the Unix member is not accepted on Windows and vice versa.
	unix, unixIntegrity := archiveFixture(t, pe, "package/bin/grok.br")
	if _, err := ExtractBinaryFor("windows", unix, unixIntegrity); err == nil || !strings.Contains(err.Error(), "grok.exe.br") {
		t.Fatalf("unix member accepted on windows: %v", err)
	}
	if _, err := ExtractBinaryFor("linux", data, integrity); err == nil {
		t.Fatal("windows member accepted on linux")
	}
	if _, err := ExtractBinaryFor("darwin", data, integrity); err == nil {
		t.Fatal("windows member accepted on darwin")
	}
	for _, names := range [][]string{
		{"package/grok.exe.br"},
		{"package/bin/grok.exe"},
		{"../../grok.exe.br"},
		{"package/bin/GROK.EXE.BR"},
		{"package/bin/grok.exe.br", "package/bin/grok.exe.br"}, // duplicate
	} {
		d, i := archiveFixture(t, pe, names...)
		if _, err := ExtractBinaryFor("windows", d, i); err == nil {
			t.Errorf("invalid members accepted: %v", names)
		}
	}

	// Integrity (sha512 over the whole archive) still gates extraction.
	tampered := append([]byte(nil), data...)
	tampered[len(tampered)-1] ^= 1
	if _, err := ExtractBinaryFor("windows", tampered, integrity); err == nil {
		t.Fatal("tampered archive accepted")
	}
	if _, err := ExtractBinaryFor("windows", data, "sha256-invalid"); err == nil {
		t.Fatal("weak integrity accepted")
	}
	if _, err := ExtractBinaryFor("windows", data, "sha512-"+strings.Repeat("A", 86)+"=="); err == nil {
		t.Fatal("wrong digest accepted")
	}

	// A Windows member that is not a PE image is refused; the check is Windows-only.
	elf, elfIntegrity := archiveFixture(t, []byte("\x7fELF not a PE"), "package/bin/grok.exe.br")
	if _, err := ExtractBinaryFor("windows", elf, elfIntegrity); err == nil || !strings.Contains(err.Error(), "PE") {
		t.Fatalf("non-PE Windows binary accepted: %v", err)
	}
	empty, emptyIntegrity := archiveFixture(t, nil, "package/bin/grok.exe.br")
	if _, err := ExtractBinaryFor("windows", empty, emptyIntegrity); err == nil {
		t.Fatal("empty binary accepted")
	}
	linux, linuxIntegrity := archiveFixture(t, []byte("\x7fELF linux"), "package/bin/grok.br")
	if got, err := ExtractBinaryFor("linux", linux, linuxIntegrity); err != nil || len(got) == 0 {
		t.Fatalf("linux extraction changed: %q, %v", got, err)
	}
}
