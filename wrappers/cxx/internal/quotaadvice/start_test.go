package quotaadvice

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func chooser(t *testing.T, input string) (Chooser, *bytes.Buffer) {
	t.Helper()
	out := new(bytes.Buffer)
	return Chooser{Input: strings.NewReader(input), Output: out, Now: testNow, Interactive: true, Available: func(string) bool { return true }, StatePath: filepath.Join(t.TempDir(), "choices", "day.json"), Instance: "https://example.test"}, out
}
func TestChooseAndRememberAcrossAliases(t *testing.T) {
	u, _ := chooser(t, "4\n")
	c := comparison()
	got, err := u.Choose(context.Background(), c, "codex", false)
	if err != nil || got.Engine != "claude" {
		t.Fatalf("%+v %v", got, err)
	}
	for _, current := range []string{"codex", "claude"} {
		u.Input = strings.NewReader("")
		got, err = u.Choose(context.Background(), c, current, false)
		if err != nil || got.Engine != "claude" || got.Cancel {
			t.Fatalf("remember across aliases: %+v %v", got, err)
		}
	}
	st, err := os.Stat(u.StatePath)
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatal("state not private")
	}
	if LoadChoice(u.StatePath, "https://other.test", testNow) != nil {
		t.Fatal("cross-instance choice")
	}
	if err = ClearChoice(u.StatePath); err != nil {
		t.Fatal(err)
	}
	if LoadChoice(u.StatePath, u.Instance, testNow) != nil {
		t.Fatal("choice not cleared")
	}
}
func TestNoInteractiveBehaviorInOffHintOrHeadless(t *testing.T) {
	for _, mode := range []string{"off", "hint", "ask"} {
		for _, interactive := range []bool{false, true} {
			if mode == "ask" && interactive {
				continue
			}
			t.Run(mode+string(rune('0'+boolInt(interactive))), func(t *testing.T) {
				u, out := chooser(t, "")
				u.Interactive = interactive
				c := comparison()
				c.Settings.Mode = mode
				if err := SaveChoice(u.StatePath, u.Instance, "claude", testNow); err != nil {
					t.Fatal(err)
				}
				got, err := u.Choose(context.Background(), c, "codex", false)
				if err != nil || got.Engine != "codex" || got.Cancel {
					t.Fatalf("unexpected switch: %+v %v", got, err)
				}
				if strings.Contains(out.String(), "[1]") || strings.Contains(out.String(), "Remember") {
					t.Fatal("unexpected question")
				}
			})
		}
	}
}
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
func TestResumeRequiresConfirmationEvenWhenRemembered(t *testing.T) {
	u, out := chooser(t, "n\n")
	c := comparison()
	if err := SaveChoice(u.StatePath, u.Instance, "claude", testNow); err != nil {
		t.Fatal(err)
	}
	got, err := u.Choose(context.Background(), c, "codex", true)
	if err != nil || got.Engine != "codex" || !strings.Contains(out.String(), "NEW session") {
		t.Fatalf("unsafe resume: %+v %v %s", got, err, out)
	}
	u.Input = strings.NewReader("y\n")
	got, err = u.Choose(context.Background(), c, "codex", true)
	if err != nil || got.Engine != "claude" {
		t.Fatal("confirmed switch missing")
	}
}
func TestCancelAndEOF(t *testing.T) {
	for _, answer := range []string{"q\n", "", "5\n"} {
		u, _ := chooser(t, answer)
		got, err := u.Choose(context.Background(), comparison(), "codex", false)
		if err != nil || !got.Cancel {
			t.Fatalf("%q: %+v %v", answer, got, err)
		}
	}
}
func TestUnavailableTargetAndStaleComparison(t *testing.T) {
	u, out := chooser(t, "y\nn\n")
	u.Available = func(engine string) bool { return engine == "codex" }
	if err := SaveChoice(u.StatePath, u.Instance, "claude", testNow); err != nil {
		t.Fatal(err)
	}
	got, err := u.Choose(context.Background(), comparison(), "codex", false)
	if err != nil || got.Engine != "codex" || LoadChoice(u.StatePath, u.Instance, testNow) != nil {
		t.Fatal("unavailable target retained")
	}
	u.Available = func(string) bool { return true }
	c := comparison()
	c.Claude.FetchedAt = ""
	got, err = u.Choose(context.Background(), c, "codex", false)
	if err != nil || got.Engine != "codex" || !strings.Contains(out.String(), "comparison unavailable") {
		t.Fatal("stale alternative recommended")
	}
}
func TestStateFailureDoesNotLoseCurrentSelection(t *testing.T) {
	u, out := chooser(t, "4\n")
	u.StatePath = filepath.Join("/dev/null", "choice.json")
	got, err := u.Choose(context.Background(), comparison(), "codex", false)
	if err != nil || got.Engine != "claude" || !strings.Contains(out.String(), "this start only") {
		t.Fatalf("%+v %v %s", got, err, out)
	}
}
func TestMidnightAndDamagedState(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	for _, now := range []time.Time{time.Date(2026, 3, 29, 0, 30, 0, 0, loc), time.Date(2026, 10, 25, 0, 30, 0, 0, loc)} {
		u, _ := chooser(t, "")
		if err = SaveChoice(u.StatePath, u.Instance, "claude", now); err != nil {
			t.Fatal(err)
		}
		if LoadChoice(u.StatePath, u.Instance, nextMidnight(now).Add(-time.Second)) == nil || LoadChoice(u.StatePath, u.Instance, nextMidnight(now)) != nil {
			t.Fatal("DST/midnight expiry")
		}
		if err = os.WriteFile(u.StatePath, []byte("broken"), 0600); err != nil {
			t.Fatal(err)
		}
		if LoadChoice(u.StatePath, u.Instance, now) != nil {
			t.Fatal("corrupt state accepted")
		}
	}
}

func TestOnlyArmedAgentChildrenCountAsStarted(t *testing.T) {
	s := new(Session)
	ctx := WithSession(context.Background(), s)
	MarkStarted(ctx)
	if s.Started {
		t.Fatal("login recovery counted as an agent session")
	}
	ArmLaunch(ctx)
	if s.Started {
		t.Fatal("prelaunch failure would count as started")
	}
	MarkStarted(ctx)
	if !s.Started {
		t.Fatal("successful child start was not recorded")
	}
}
func TestAutomationArgsDisableInteraction(t *testing.T) {
	for _, tc := range []struct {
		engine string
		args   []string
		want   bool
	}{
		{"claude", []string{"--print"}, true}, {"claude", []string{"-p", "question"}, true},
		{"codex", []string{"exec", "task"}, true}, {"codex", []string{"--json"}, true},
		{"claude", []string{"--", "--print"}, false}, {"codex", []string{"resume"}, false},
	} {
		if got := automatedArgs(tc.engine, tc.args); got != tc.want {
			t.Fatalf("%v: %v", tc, got)
		}
	}
}

func TestMissingRememberedProviderNeverFallsBackWithoutConsent(t *testing.T) {
	u, _ := chooser(t, "n\n")
	u.Available = func(e string) bool { return e == "codex" }
	if err := SaveChoice(u.StatePath, u.Instance, "claude", testNow); err != nil {
		t.Fatal(err)
	}
	got, err := u.Choose(context.Background(), comparison(), "codex", false)
	if err != nil || !got.Cancel {
		t.Fatalf("unapproved fallback: %+v %v", got, err)
	}
}

func TestHotkeysFollowEngineAndRemember(t *testing.T) {
	for _, tc := range []struct {
		current, answer, want string
		remember              bool
	}{
		{"codex", "1\n", "codex", false}, {"codex", "2\n", "claude", false},
		{"codex", "3\n", "codex", true}, {"codex", "4\n", "claude", true},
		{"codex", "\n", "codex", false},
	} {
		u, out := chooser(t, tc.answer)
		got, err := u.Choose(context.Background(), comparison(), tc.current, false)
		if err != nil || got.Cancel || got.Engine != tc.want {
			t.Fatalf("%+v: %+v %v", tc, got, err)
		}
		if saved := LoadChoice(u.StatePath, u.Instance, testNow) != nil; saved != tc.remember {
			t.Fatalf("%+v: remembered=%v", tc, saved)
		}
		if strings.Contains(out.String(), "Remember") {
			t.Fatalf("%+v: follow-up remember question", tc)
		}
	}
}
func TestRememberOptionsHiddenWhenDisabled(t *testing.T) {
	u, out := chooser(t, "3\n")
	c := comparison()
	c.Settings.RememberDay = false
	got, err := u.Choose(context.Background(), c, "codex", false)
	if err != nil || !got.Cancel || strings.Contains(out.String(), "[3]") {
		t.Fatalf("remember option offered: %+v %v %s", got, err, out)
	}
}
