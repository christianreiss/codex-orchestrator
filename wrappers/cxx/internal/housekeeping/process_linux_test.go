//go:build linux

package housekeeping

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestNativeBusySeesShellLaunchAndExecutableInSpacedDirectory(t *testing.T) {
	for _, shell := range []bool{false, true} {
		t.Run(map[bool]string{false: "binary", true: "shell"}[shell], func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "native clients")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			// A unique synthetic engine keeps this test independent of real agents.
			engine := filepath.Base(filepath.Dir(dir)) + "-housekeeping-fixture"
			binary := filepath.Join(dir, engine)
			var cmd *exec.Cmd
			if shell {
				if err := os.WriteFile(binary, []byte("#!/bin/sh\nread line\n"), 0700); err != nil {
					t.Fatal(err)
				}
				cmd = exec.Command("/bin/sh", binary)
			} else {
				raw, err := os.ReadFile("/bin/sleep")
				if err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(binary, raw, 0700); err != nil {
					t.Fatal(err)
				}
				cmd = exec.Command(binary, "60")
			}
			stdin, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			defer stdin.Close()
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
			deadline := time.Now().Add(2 * time.Second)
			for {
				busy, err := nativeBusy(engine)
				if err != nil {
					t.Fatal(err)
				}
				if busy {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("live native process not found")
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
	}
}
