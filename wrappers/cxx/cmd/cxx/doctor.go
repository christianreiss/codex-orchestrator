package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/clihelp"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/launcherdoctor"
	ui "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

// This local recovery entrypoint deliberately needs neither signed config nor
// API/auth access: the broken persona script may prevent reaching its doctor.
func runLauncherDoctor(args []string, w, stderr io.Writer) int {
	if clihelp.Requested(args) {
		fmt.Fprintln(w, "Usage: cxx doctor [--fix] [--minimal]\nChecks local wrapper commands on PATH only: it does not check API reachability, TLS trust or sync. --fix repairs recognized legacy transition scripts.\nFor those checks and full engine diagnostics: cdx|clx|cgx|ckx doctor (or cxx codex|claude|grok|kimi doctor)")
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
	var engines, personas []string
	for _, entry := range []struct{ engine, name string }{{"codex", "cdx"}, {"claude", "clx"}, {"grok", "cgx"}, {"kimi", "ckx"}} {
		if _, err := exec.LookPath(entry.name); err == nil {
			engines = append(engines, entry.engine)
			personas = append(personas, entry.name)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	row := launcherdoctor.Row(ctx, exe, engines, fix)
	caps := ui.DetectCapsFor(w, "")
	if minimal {
		caps = ui.MinimalCaps(caps)
	}
	// The pointer is a dim row, not a hint: hints render as warnings, and a
	// passing launcher check needs no action.
	report := ui.DoctorReport{Engine: "cxx", When: time.Now(), Rows: []ui.DoctorRow{row,
		{Label: "Scope", Tone: ui.ToneDim, Value: "local launchers only; API reachability, TLS trust and sync are not checked"},
		{Label: "API checks", Tone: ui.ToneDim, Value: engineDoctorHint(personas)},
	}, Result: ui.DoctorRow{Label: "Result", Tone: row.Tone, Value: "local launcher checks passed"}}
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

// engineDoctorHint points to the engine doctors, which load signed config and
// reach the API, so a TLS trust or sync failure shows up there and not here.
// It names the persona commands found on PATH and all four when none was.
func engineDoctorHint(personas []string) string {
	if len(personas) == 0 {
		personas = []string{"cdx", "clx", "cgx", "ckx"}
	}
	commands := make([]string, len(personas))
	for i, name := range personas {
		commands[i] = "`" + name + " doctor`"
	}
	return "This check does not contact the API. For API reachability, TLS trust and sync, run " + strings.Join(commands, ", ") + "."
}
