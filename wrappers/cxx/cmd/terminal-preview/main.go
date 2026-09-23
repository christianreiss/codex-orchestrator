// terminal-preview exercises the production renderers with deterministic sample
// data. It never reads fleet configuration, credentials, or the network, and is
// a developer command rather than part of the installed cxx command surface.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	clx "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
	cdx "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
)

func main() {
	engine := flag.String("engine", "codex", "codex or claude")
	scene := flag.String("scene", "startup", "startup, attention, blocked, concurrent, stale, forecast, security, doctor, help, session, updates, notices, or prompt")
	minimal := flag.Bool("minimal", false, "portable ASCII output")
	flag.Parse()
	if (*engine != "codex" && *engine != "claude") || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "terminal-preview: use -engine codex or -engine claude")
		os.Exit(2)
	}
	valid := map[string]bool{"startup": true, "attention": true, "blocked": true, "concurrent": true, "stale": true, "forecast": true, "security": true, "doctor": true, "help": true, "session": true, "updates": true, "notices": true, "prompt": true}
	if !valid[*scene] || (*scene == "security" && *engine != "claude") {
		fmt.Fprintln(os.Stderr, "terminal-preview: unknown scene; security requires Claude")
		os.Exit(2)
	}
	preview(*engine, *scene, *minimal)
}

func preview(engine, scene string, minimal bool) {
	caps := cdx.DetectCapsFor(os.Stdout, "auto")
	prefix, model, version := "cdx", "gpt-6-astra", "0.144.1"
	if engine == "claude" {
		caps = clx.DetectCapsFor(os.Stdout, "auto")
		prefix, model, version = "clx", "claude-opus-4-6", "2.1.71"
	}
	if minimal {
		caps = cdx.MinimalCaps(caps)
	}
	switch scene {
	case "help":
		if engine == "claude" {
			clx.PrintWrapperHelp(os.Stdout, caps)
		} else {
			cdx.PrintWrapperHelp(os.Stdout, caps)
		}
		return
	case "doctor":
		cdx.PrintDoctor(os.Stdout, caps, cdx.DoctorReport{
			Engine: prefix, When: time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC),
			Rows: []cdx.DoctorRow{
				{Label: "config", Tone: cdx.ToneOK, Value: "signature verified; engine " + engine},
				{Label: "client", Tone: cdx.ToneOK, Value: engine + " " + version},
				{Label: "auth", Tone: cdx.ToneOK, Value: "credentials present and usable"},
				{Label: "api", Tone: cdx.ToneOK, Value: "reachable in 42ms"},
				{Label: "settings", Tone: cdx.ToneWarn, Value: "local settings changed since the last fleet sync"},
				{Label: "cron", Tone: cdx.ToneOK, Value: "shared cxx schedule installed"},
			},
			Hints:  []string{"Run `" + prefix + " sync` to apply the managed settings, then retry `" + prefix + " doctor`."},
			Result: cdx.DoctorRow{Label: "result", Tone: cdx.ToneWarn, Value: "One check needs attention; authentication is usable."},
		})
		return
	case "session":
		cdx.PrintExitFooter(os.Stdout, caps, prefix, cdx.ExitFooter{RunDuration: 12*time.Minute + 34*time.Second, ExitCode: 0, AuthStatus: "synced", AuthTone: cdx.ToneOK, EngineName: engine, EngineVersion: version})
		cdx.PrintExitFooter(os.Stdout, caps, prefix, cdx.ExitFooter{RunDuration: 2*time.Minute + 7*time.Second, ExitCode: 0, AuthStatus: "upload failed; local credentials retained", AuthTone: cdx.ToneFail, EngineName: engine, EngineVersion: version})
		return
	case "notices":
		for _, n := range []cdx.Notice{
			{Prefix: prefix, Topic: cdx.TopicSync, Tone: cdx.ToneOK, Message: strings.ToUpper(engine[:1]) + engine[1:] + " updated 0.144.0 → " + version},
			{Prefix: prefix, Topic: cdx.TopicAuth, Tone: cdx.ToneDim, Message: "insecure-host credentials purged"},
			{Prefix: prefix, Topic: cdx.TopicSession, Tone: cdx.ToneWarn, Message: "another session is active; managed sync paused"},
			{Prefix: prefix, Topic: cdx.TopicUpload, Tone: cdx.ToneFail, Message: "server rejected the credential upload", Details: []string{"Retry with `" + prefix + " auth-upload` later."}},
		} {
			cdx.PrintNotice(os.Stdout, caps, n)
		}
		return
	case "prompt":
		other, otherName := "Claude (clx)", "claude"
		if engine == "claude" {
			other, otherName = "OpenAI (cdx)", "codex"
		}
		self := "OpenAI (cdx)"
		if engine == "claude" {
			self = "Claude (clx)"
		}
		ctx := context.Background()
		q := cdx.Question{Prefix: prefix, Topic: cdx.TopicQuota, Tone: cdx.ToneWarn, Title: "Recommend " + other, Details: []string{
			self + ": 5h 97% used; resets in 1h12m",
			other + ": 5h 18% used; resets in 3h5m",
		}}
		answer, err := cdx.Select(ctx, caps, os.Stdin, os.Stdout, q, []cdx.Option{{Key: "1", Label: "Keep " + self}, {Key: "2", Label: "Switch to " + other}}, "1")
		if err != nil {
			fmt.Fprintln(os.Stdout)
			cdx.PrintNotice(os.Stdout, caps, cdx.Notice{Prefix: prefix, Topic: cdx.TopicQuota, Tone: cdx.ToneDim, Message: "cancelled; nothing started"})
			return
		}
		if answer == "2" {
			_, _ = cdx.Confirm(ctx, caps, os.Stdin, os.Stdout, cdx.Question{Prefix: prefix, Topic: cdx.TopicQuota, Title: "Remember " + other + " for today on this computer?"})
			cdx.PrintNotice(os.Stdout, caps, cdx.Notice{Prefix: prefix, Topic: cdx.TopicQuota, Tone: cdx.ToneOK, Message: "starting " + otherName})
		}
		return
	case "updates":
		fmt.Fprintln(os.Stdout, cdx.UpdateProgress(caps, prefix, "wrapper", "0.7.28", "0.8.0"))
		fmt.Fprintln(os.Stdout, cdx.UpdateComplete(caps, prefix, "wrapper", "0.8.0", true))
		fmt.Fprintln(os.Stdout, cdx.UpdateFailure(caps, prefix, engine, version, fmt.Errorf("download unavailable; installed version retained")))
		return
	}

	in := cdx.ScreenInput{
		WrapperVersion: "0.8.0", WrapperTone: cdx.ToneOK,
		CodexVersion: version, CodexTone: cdx.ToneOK,
		HostFQDN: "workstation.example", Model: model, Effort: "high", APICalls: 1284,
		Dots: []cdx.HealthDot{
			{Name: "api", Tone: cdx.ToneOK}, {Name: "auth", Tone: cdx.ToneOK},
			{Name: "runner", Tone: cdx.ToneOK}, {Name: "agents", Tone: cdx.ToneOK, Updated: true},
			{Name: "config", Tone: cdx.ToneOK}, {Name: "skills", Tone: cdx.ToneOK},
		},
		QuotaRows: []cdx.QuotaRow{
			{Label: "5h", Used: 32, ResetAfter: 2*time.Hour + 18*time.Minute},
			{Label: "weekly", Used: 61, ResetAfter: 3*24*time.Hour + 4*time.Hour},
		},
		SessionRows: []cdx.SessionRow{{Label: "local procs", Count: 1}, {Label: "hosts 30m", Count: 8}, {Label: "syncs UTC day", Count: 143}},
		ResultLabel: "Managed state is current. Ready to launch " + strings.ToUpper(engine[:1]) + engine[1:] + ".", ResultTone: cdx.ToneOK,
	}
	switch scene {
	case "attention":
		in.Dots[4].Tone = cdx.ToneWarn
		in.QuotaRows[0].Used = 86
		in.QuotaWarn = "5h usage is high; reset in 2h 18m."
		in.ResultLabel, in.ResultTone = "Config sync failed; local configuration retained. Run `"+prefix+" doctor` for details.", cdx.ToneWarn
	case "blocked":
		in.Dots[1].Tone = cdx.ToneFail
		in.ResultLabel, in.ResultTone = "Authentication was rejected. Restore credentials before launching.", cdx.ToneFail
	case "concurrent":
		in.Concurrent = true
		in.ConcurrentNote = "Managed content sync paused; auth freshness remains active."
		in.ResultLabel = in.ConcurrentNote
		for i := 3; i < len(in.Dots); i++ {
			in.Dots[i].Tone, in.Dots[i].Updated = cdx.ToneDim, false
		}
	case "stale":
		for i := range in.QuotaRows {
			in.QuotaRows[i].Stale = true
			in.QuotaRows[i].Note = "last reported usage"
		}
		in.QuotaRows[0].Used = 100
		in.QuotaWarn = "Quota telemetry is stale; awaiting a new report."
		in.ResultLabel, in.ResultTone = "Last-known usage is shown for context. Authentication remains usable.", cdx.ToneWarn
	case "forecast":
		in.QuotaRows[0].Used = 94
		in.QuotaRows[0].ResetAfter = 42 * time.Minute
		in.QuotaRows[0].Projection = "~123% at reset; 100% in 18m"
		in.QuotaRows[0].ProjectionTone = cdx.ToneWarn
		in.ResultLabel, in.ResultTone = "Quota forecast crosses the limit before reset; advisory only.", cdx.ToneWarn
	}
	if engine == "claude" {
		input := clx.ScreenInput{
			WrapperVersion: in.WrapperVersion, WrapperTone: in.WrapperTone,
			ClaudeVersion: version, ClaudeTone: in.CodexTone,
			HostFQDN: in.HostFQDN, Model: model, Effort: in.Effort, APICalls: in.APICalls,
			Dots: in.Dots, QuotaRows: in.QuotaRows, QuotaWarn: in.QuotaWarn,
			SessionRows: in.SessionRows, Concurrent: in.Concurrent, ConcurrentNote: in.ConcurrentNote,
			ResultLabel: in.ResultLabel, ResultTone: in.ResultTone, BypassPermissions: scene == "security",
		}
		if minimal {
			clx.PrintMinimalScreen(os.Stdout, input)
		} else {
			clx.PrintBootScreen(os.Stdout, input)
		}
		return
	}
	if minimal {
		cdx.PrintMinimalScreen(os.Stdout, in)
	} else {
		cdx.PrintBootScreen(os.Stdout, in)
	}
}
