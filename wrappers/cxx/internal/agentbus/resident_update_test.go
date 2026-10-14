package agentbus

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResidentRequestDirIsReachableForTheServiceUser(t *testing.T) {
	root := t.TempDir()
	previous := residentUpdateRequestDir
	residentUpdateRequestDir = filepath.Join(root, "var", "lib", "cxx-daemon", "requests")
	t.Cleanup(func() { residentUpdateRequestDir = previous })
	if err := prepareResidentRequestDir(os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	parent, err := os.Stat(filepath.Dir(residentUpdateRequestDir))
	if err != nil || parent.Mode().Perm() != 0o755 {
		t.Fatalf("parent must be traversable 0755, got %v %v", parent.Mode().Perm(), err)
	}
	dir, err := os.Lstat(residentUpdateRequestDir)
	if err != nil || dir.Mode().Perm() != 0o700 {
		t.Fatalf("request dir must be private 0700, got %v %v", dir.Mode().Perm(), err)
	}
	if err := prepareResidentRequestDir(os.Getuid(), os.Getgid()); err != nil {
		t.Fatalf("re-running install must be idempotent: %v", err)
	}
	if err := RequestResidentUpdate("0.9.82", strings.Repeat("AB", 32), "/home/u/.local/bin/cxx"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(residentUpdateRequestFile())
	if err != nil {
		t.Fatal(err)
	}
	var req ResidentUpdateRequest
	if err := json.Unmarshal(raw, &req); err != nil || req.Version != "0.9.82" || req.SHA256 != strings.Repeat("ab", 32) || req.RequestID == "" {
		t.Fatalf("unexpected request %+v (%v)", req, err)
	}
}

func TestResidentUpdateUnitsCarryServiceEnvironment(t *testing.T) {
	pathUnit, serviceUnit := residentUpdateUnits("Environment=\"HOME=/home/u\"\nEnvironment=\"CLX_CONFIG_PATH=/home/u/.config/clx.json\"\n", "/usr/local/lib/cxx-daemon/cxx")
	if !strings.Contains(pathUnit, "PathChanged=/var/lib/cxx-daemon/requests/update.json") || !strings.Contains(pathUnit, "Unit=cxx-daemon-update.service") {
		t.Fatalf("path unit: %s", pathUnit)
	}
	for _, want := range []string{"Type=oneshot", "CLX_CONFIG_PATH=/home/u/.config/clx.json", "daemon apply-update"} {
		if !strings.Contains(serviceUnit, want) {
			t.Fatalf("service unit lacks %q: %s", want, serviceUnit)
		}
	}
	if strings.Contains(serviceUnit, "User=") {
		t.Fatal("the handoff oneshot must run as root")
	}
}
