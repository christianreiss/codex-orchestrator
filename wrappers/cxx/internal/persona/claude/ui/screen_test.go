package ui

import (
	"bytes"
	"strings"
	"testing"
)

func TestPersonaScreenKeepsEngineFieldsAndQuota(t *testing.T) {
	var out bytes.Buffer
	PrintMinimalScreen(&out, ScreenInput{ClaudeVersion: "1.2.3", ClaudeTarget: "1.2.4", QuotaRows: []QuotaRow{{Label: "weekly", Used: 45, Stale: true}}, QuotaWarn: "Last report needs refresh."})
	for _, want := range []string{"claude=1.2.3->1.2.4", "quota | weekly=45%", "stale=true", "warning | Last report needs refresh."} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("persona adapter dropped %q: %s", want, out.String())
		}
	}
}

func TestSkipBannerRemainsEngineScoped(t *testing.T) {
	t.Setenv("CLX_SKIP_BANNER", "")
	t.Setenv("CDX_SKIP_BANNER", "1")
	if sharedScreen(ScreenInput{}).SkipBanner {
		t.Fatal("Codex banner setting leaked to Claude")
	}
	t.Setenv("CLX_SKIP_BANNER", "1")
	if !sharedScreen(ScreenInput{}).SkipBanner {
		t.Fatal("Claude banner setting was ignored")
	}
}

func TestLoginWarningVisibleInFullAndMinimalScreens(t *testing.T) {
	for _, minimal := range []bool{false, true} {
		var out bytes.Buffer
		input := ScreenInput{LoginWarning: "Claude login expires in 3 days. Run /login in Claude launched through clx."}
		if minimal {
			PrintMinimalScreen(&out, input)
		} else {
			PrintBootScreen(&out, input)
		}
		if strings.Count(out.String(), input.LoginWarning) != 1 {
			t.Fatalf("warning: %q", out.String())
		}
	}
}
