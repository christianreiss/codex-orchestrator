package nativeentry

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
)

// Invoked first as the fixture owner, then as real root. Never uses a user's HOME.
func TestIndependentRootPrewriteProtection(t *testing.T) {
	home := os.Getenv("CXX_REVIEW_FOREIGN_FIXTURE")
	if home == "" {
		t.Skip("requires disposable fixture path")
	}
	opts := Options{Home: home, WrapperPath: "/fixture/cxx", Engines: []string{"codex", "claude", "grok"}}
	if os.Geteuid() != 0 {
		if err := Install(opts); err != nil {
			t.Fatal(err)
		}
		return
	}
	snapshot := func() map[string]string {
		out := map[string]string{}
		err := filepath.Walk(home, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			st := info.Sys().(*syscall.Stat_t)
			body := []byte{}
			if !info.IsDir() {
				body, err = os.ReadFile(path)
				if err != nil {
					return err
				}
			}
			out[path] = fmt.Sprintf("%d:%d:%v:%d:%s", st.Uid, st.Gid, info.Mode(), info.ModTime().UnixNano(), body)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	before := snapshot()
	for name, action := range map[string]func() error{
		"install":              func() error { return Install(opts) },
		"authoritative remove": func() error { return Sync(home, opts.WrapperPath, nil) },
		"explicit remove":      func() error { return Remove(opts) },
	} {
		err := action()
		t.Logf("%s as uid 0: %v", name, err)
		if !errors.Is(err, ErrForeignHome) {
			t.Fatalf("%s did not refuse foreign fixture: %v", name, err)
		}
		if !reflect.DeepEqual(before, snapshot()) {
			t.Fatalf("%s changed fixture ownership, mode, mtime or content", name)
		}
	}
}
