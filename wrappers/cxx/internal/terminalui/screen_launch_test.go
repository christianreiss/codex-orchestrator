package terminalui

import (
	"bytes"
	"strings"
	"testing"
)

func launchScreen() ScreenInput {
	in := ScreenInput{Prefix: "cdx", EngineName: "codex", HostFQDN: "docker03.example", Lane: "normal", Model: "gpt-6.2-sol", Effort: "medium",
		Dots: []HealthDot{{Name: "api", Tone: ToneOK}}, SessionRows: []SessionRow{{Label: "local procs", Count: 1}},
		ResultLabel: "Ready - all systems operational.", ResultTone: ToneOK}
	in.Launch = LaunchInfo{Account: "ChatGPT", Session: "Anke", PolicyFrom: "gpt-6.1-sol", Communicator: "running · pid 1436 · 0 sessions · 5 leases (codex 2)"}
	in.Launch.AddDot("daemon", ToneOK, false)
	in.Launch.AddDot("communicator", ToneOK, false)
	return in
}

func TestLaunchInfoRendersInsideTheRichCard(t *testing.T) {
	for _, cols := range []int{80, 120} {
		var buf bytes.Buffer
		printBootScreen(&buf, launchScreen(), screenCaps(cols))
		out := StripANSI(buf.String())
		for _, want := range []string{"session Anke", "gpt-6.2-sol/medium", "(policy: gpt-6.1-sol → gpt-6.2-sol)", "normal lane · ChatGPT", "✓ daemon", "✓ communicator", "communicator running · pid 1436", "Ready - all systems operational."} {
			if !strings.Contains(out, want) {
				t.Fatalf("cols=%d missing %q:\n%s", cols, want, out)
			}
		}
		assertScreenLinesFit(t, out, cols)
		lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
		if !strings.HasPrefix(strings.TrimSpace(lines[0]), "╭") || !strings.HasPrefix(strings.TrimSpace(lines[len(lines)-1]), "╰") {
			t.Fatalf("output is not exactly one card:\n%s", out)
		}
	}
}

func TestLaunchInfoMinimalFields(t *testing.T) {
	var buf bytes.Buffer
	PrintMinimalScreen(&buf, launchScreen())
	out := buf.String()
	for _, want := range []string{"model=gpt-6.2-sol/medium", "policy_from=gpt-6.1-sol", "account=ChatGPT", "session=Anke", "daemon=ok", "communicator | running | pid 1436"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q: %s", want, out)
		}
	}
}

func TestLaunchProblemEscalatesOKCardWithoutContradiction(t *testing.T) {
	in := launchScreen()
	in.Launch.Dots = nil
	in.Launch.AddDot("daemon", ToneWarn, false)
	in.Launch.AddProblem("host daemon: daemon update pending; run 'sudo cxx daemon install'")
	for _, rich := range []bool{true, false} {
		var buf bytes.Buffer
		caps := screenCaps(100)
		caps.IsTTY = rich
		printBootScreen(&buf, in, caps)
		out := StripANSI(buf.String())
		if !strings.Contains(out, "daemon update pending") || strings.Contains(out, "all systems operational") {
			t.Fatalf("rich=%v problem not escalated:\n%s", rich, out)
		}
		if rich && !strings.Contains(out, "ATTENTION") {
			t.Fatalf("badge not escalated:\n%s", out)
		}
	}
	// A failing verdict keeps its own label next to the problem line.
	in.ResultTone, in.ResultLabel = ToneFail, "launch refused: identity"
	var buf bytes.Buffer
	printBootScreen(&buf, in, screenCaps(100))
	if out := StripANSI(buf.String()); !strings.Contains(out, "launch refused: identity") || !strings.Contains(out, "daemon update pending") {
		t.Fatalf("failure label lost:\n%s", out)
	}
}

func TestPolicyNoteHiddenWhenModelUnchanged(t *testing.T) {
	in := launchScreen()
	in.Launch.PolicyFrom = in.Model
	var buf bytes.Buffer
	printBootScreen(&buf, in, screenCaps(100))
	if strings.Contains(StripANSI(buf.String()), "policy:") {
		t.Fatalf("unchanged model shows a policy note:\n%s", buf.String())
	}
}
