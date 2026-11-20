package main

import (
	"bytes"
	"os"
	"path/filepath"
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

func TestEngineDoctorHintNamesInstalledPersonasOrAllFour(t *testing.T) {
	if got := engineDoctorHint([]string{"cdx", "ckx"}); !strings.Contains(got, "`cdx doctor`, `ckx doctor`") || strings.Contains(got, "clx") || !strings.Contains(got, "TLS trust") {
		t.Fatalf("installed personas: %s", got)
	}
	got := engineDoctorHint(nil)
	for _, name := range []string{"cdx", "clx", "cgx", "ckx"} {
		if !strings.Contains(got, "`"+name+" doctor`") {
			t.Fatalf("fallback hint lacks %s: %s", name, got)
		}
	}
}

func TestLauncherDoctorReportStatesScopeAndPointsToEngineDoctors(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// A PATH without persona commands keeps the fallback list deterministic.
	t.Setenv("PATH", filepath.Join(home, "empty"))
	if err := os.MkdirAll(filepath.Join(home, "empty"), 0o700); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	run("cxx", []string{"doctor", "--minimal"}, &out, &stderr)
	text := out.String()
	for _, want := range []string{"local launchers only", "not checked", "cdx doctor", "clx doctor", "cgx doctor", "ckx doctor"} {
		if !strings.Contains(text, want) {
			t.Fatalf("report lacks %q: stdout=%s stderr=%s", want, text, &stderr)
		}
	}
}
