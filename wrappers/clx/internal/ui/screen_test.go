package ui

import (
	"bytes"
	"strings"
	"testing"
)

func TestPrintBootScreenShowsBypassPermissionsBadge(t *testing.T) {
	var buf bytes.Buffer
	PrintBootScreen(&buf, ScreenInput{
		WrapperVersion:    "1.0.0",
		ClaudeVersion:     "2.0.0",
		BypassPermissions: true,
		Theme:             "auto",
	})
	if !strings.Contains(buf.String(), "bypass permissions") {
		t.Errorf("expected bypass-permissions badge in boot screen; got:\n%s", buf.String())
	}
}

func TestPrintBootScreenOmitsBypassPermissionsBadgeByDefault(t *testing.T) {
	var buf bytes.Buffer
	PrintBootScreen(&buf, ScreenInput{
		WrapperVersion: "1.0.0",
		ClaudeVersion:  "2.0.0",
		Theme:          "auto",
	})
	if strings.Contains(buf.String(), "bypass permissions") {
		t.Errorf("did not expect bypass-permissions badge; got:\n%s", buf.String())
	}
}

func TestPrintMinimalScreenShowsBypassPermissionsWarning(t *testing.T) {
	var buf bytes.Buffer
	PrintMinimalScreen(&buf, ScreenInput{
		BypassPermissions: true,
		ResultLabel:       "Ready.",
	})
	out := buf.String()
	if !strings.Contains(out, "Warn    | bypass permissions active (--dangerously-skip-permissions)") {
		t.Errorf("expected bypass-permissions warning row; got:\n%s", out)
	}
}

func TestPrintMinimalScreenOmitsBypassPermissionsWarningByDefault(t *testing.T) {
	var buf bytes.Buffer
	PrintMinimalScreen(&buf, ScreenInput{ResultLabel: "Ready."})
	if strings.Contains(buf.String(), "bypass permissions") {
		t.Errorf("did not expect bypass-permissions warning; got:\n%s", buf.String())
	}
}
