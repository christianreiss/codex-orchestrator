package kimi

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestPlatformPackageWindows(t *testing.T) {
	for _, tt := range []struct {
		os, arch, key string
		wantErr       bool
	}{
		{"windows", "amd64", "win32-x64", false},
		{"windows", "arm64", "win32-arm64", false},
		{"windows", "386", "", true},
		{"freebsd", "amd64", "", true},
		{"linux", "amd64", "linux-x64", false},
		{"linux", "arm64", "linux-arm64", false},
		{"darwin", "amd64", "darwin-x64", false},
		{"darwin", "arm64", "darwin-arm64", false},
	} {
		got, err := PlatformPackage(tt.os, tt.arch)
		if (err != nil) != tt.wantErr || got != tt.key {
			t.Errorf("%s/%s = %q, %v; want %q (err=%v)", tt.os, tt.arch, got, err, tt.key, tt.wantErr)
		}
	}
}

func TestBinaryNamePerOS(t *testing.T) {
	if binaryName("windows") != "kimi.exe" || binaryName("linux") != "kimi" || binaryName("darwin") != "kimi" {
		t.Fatal("unexpected stored binary names")
	}
}

// Shape of https://cdn.kimi.com/kimi-code/binaries/<ver>/manifest.json: the
// manifest lists win32 keys next to the four Unix ones.
const winManifest = `{"platforms":{
 "linux-x64":{"filename":"kimi-code-linux-x64","checksum":"aa"},
 "win32-x64":{"filename":"kimi-code-win32-x64.exe","checksum":"%X64%"},
 "win32-arm64":{"filename":"kimi-code-win32-arm64.exe","checksum":"%ARM%"},
 "win32-evil":{"filename":"..\\evil.exe","checksum":"00"},
 "win32-slash":{"filename":"sub/evil.exe","checksum":"00"},
 "win32-query":{"filename":"evil.exe?x=1","checksum":"00"},
 "win32-empty":{"filename":"","checksum":"00"}}}`

func TestManifestAssetWindows(t *testing.T) {
	raw := []byte(strings.NewReplacer("%X64%", strings.Repeat("1", 64), "%ARM%", strings.Repeat("2", 64)).Replace(winManifest))
	for key, wantName := range map[string]string{
		"win32-x64":   "kimi-code-win32-x64.exe",
		"win32-arm64": "kimi-code-win32-arm64.exe",
		"linux-x64":   "kimi-code-linux-x64",
	} {
		name, _, err := manifestAsset(raw, key)
		if err != nil || name != wantName {
			t.Errorf("%s = %q, %v; want %q", key, name, err, wantName)
		}
	}
	if _, sum, _ := manifestAsset(raw, "win32-arm64"); sum != strings.Repeat("2", 64) {
		t.Errorf("checksum not passed through: %q", sum)
	}
	for _, key := range []string{"win32-missing", "win32-evil", "win32-slash", "win32-query", "win32-empty"} {
		if _, _, err := manifestAsset(raw, key); err == nil {
			t.Errorf("%s accepted", key)
		}
	}
	if _, _, err := manifestAsset([]byte("{"), "win32-x64"); err == nil {
		t.Error("malformed manifest accepted")
	}
}

func TestVerifyBinaryWindowsPE(t *testing.T) {
	exe := []byte("MZ\x90\x00 kimi windows fixture")
	sum := sha256.Sum256(exe)
	good := hex.EncodeToString(sum[:])
	if err := VerifyBinary(exe, good); err != nil {
		t.Fatalf("good checksum rejected: %v", err)
	}
	if err := VerifyBinary(exe, strings.ToUpper(good)); err != nil {
		t.Fatalf("upper-case hex rejected: %v", err)
	}
	for name, checksum := range map[string]string{
		"mismatch":  strings.Repeat("0", 64),
		"short":     good[:62],
		"not hex":   strings.Repeat("z", 64),
		"empty sum": "",
	} {
		if err := VerifyBinary(exe, checksum); err == nil {
			t.Errorf("%s checksum accepted", name)
		}
	}
	tampered := append([]byte(nil), exe...)
	tampered[len(tampered)-1] ^= 1
	if err := VerifyBinary(tampered, good); err == nil {
		t.Error("tampered binary accepted")
	}
	empty := sha256.Sum256(nil)
	if err := VerifyBinary(nil, hex.EncodeToString(empty[:])); err == nil {
		t.Error("empty binary accepted")
	}
}
