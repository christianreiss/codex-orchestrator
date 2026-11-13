package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/clihelp"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/launcherdoctor"
	ui "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

// This local recovery entrypoint deliberately needs neither signed config nor
// API/auth access: the broken persona script may prevent reaching its doctor.
func runLauncherDoctor(args []string, w, stderr io.Writer) int {
	if clihelp.Requested(args) {
		fmt.Fprintln(w, "Usage: cxx doctor [--fix] [--minimal]\nChecks local wrapper commands on PATH. --fix repairs recognized legacy transition scripts.\nFor full engine diagnostics: cxx codex|claude|grok|kimi doctor")
		return 0
	}
	fix, minimal := false, false
	for _, arg := range args {
		switch arg {
		case "--fix":
			fix = true
		case "--minimal", "--minimal-output":
			minimal = true
		default:
			fmt.Fprintf(stderr, "cxx doctor: unknown argument %q\n", arg)
			return 2
		}
	}
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(stderr, "cxx doctor:", err)
		return 1
	}
	var engines []string
	for _, entry := range []struct{ engine, name string }{{"codex", "cdx"}, {"claude", "clx"}, {"grok", "cgx"}, {"kimi", "ckx"}} {
		if _, err := exec.LookPath(entry.name); err == nil {
			engines = append(engines, entry.engine)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	row := launcherdoctor.Row(ctx, exe, engines, fix)
	caps := ui.DetectCapsFor(w, "")
	if minimal {
		caps = ui.MinimalCaps(caps)
	}
	report := ui.DoctorReport{Engine: "cxx", When: time.Now(), Rows: []ui.DoctorRow{row}, Result: ui.DoctorRow{Label: "Result", Tone: row.Tone, Value: "local launcher checks passed"}}
	if row.Tone != ui.ToneOK {
		report.Result.Tone = ui.ToneFail
		report.Result.Value = "local launcher checks failed"
		report.Hints = []string{"Run `cxx doctor --fix` to repair recognized transition scripts. Unrecognized launchers and other installations require manual review."}
	}
	ui.PrintDoctor(w, caps, report)
	if row.Tone != ui.ToneOK {
		return 1
	}
	return 0
}
