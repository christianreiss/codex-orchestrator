package nativeentry

import (
	"os"
	"path/filepath"
	"testing"
)

// Real-root reproduction of `sudo env HOME=/home/user cxx ...`, opt-in only:
//
//	go test -c -o nativeentry.test ./internal/nativeentry
//	sudo env CXX_NATIVEENTRY_FOREIGN_HOME=<dir owned by the invoking user> \
//	  ./nativeentry.test -test.run TestRootLeavesForeignHomeUntouched -test.v
func TestRootLeavesForeignHomeUntouched(t *testing.T) {
	home := os.Getenv("CXX_NATIVEENTRY_FOREIGN_HOME")
	if home == "" || os.Geteuid() != 0 {
		t.Skip("needs root and CXX_NATIVEENTRY_FOREIGN_HOME")
	}
	rc := filepath.Join(home, ".bashrc")
	before, _ := os.ReadFile(rc)
	err := Install(Options{Home: home, WrapperPath: "/usr/bin/cxx", Engines: []string{"codex", "claude", "grok"}})
	t.Logf("install as root into %s: %v", home, err)
	if err == nil {
		t.Error("root installed native entries into another user's home")
	}
	if info, statErr := os.Stat(BinDir(home)); statErr == nil {
		t.Errorf("created %s (mode %v) as root", BinDir(home), info.Mode())
	}
	if after, _ := os.ReadFile(rc); string(after) != string(before) {
		t.Errorf("rewrote %s as root", rc)
	}
}
