package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestLauncherDoctorHelpAndArgumentsWithoutConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, tc := range []struct {
		args []string
		code int
		want string
	}{{[]string{"doctor", "--fix", "--help"}, 0, "Usage: cxx doctor"}, {[]string{"doctor", "--fix", "unexpected"}, 2, "unknown argument"}} {
		var out, stderr bytes.Buffer
		if code := run("cxx", tc.args, &out, &stderr); code != tc.code || !strings.Contains(out.String()+stderr.String(), tc.want) {
			t.Fatalf("args=%v code=%d stdout=%s stderr=%s", tc.args, code, &out, &stderr)
		}
	}
}
