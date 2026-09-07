package ui

import (
	"bytes"
	"strings"
	"testing"
)

func TestPersonaScreenKeepsEngineFieldsAndQuota(t *testing.T) {
	var out bytes.Buffer
	PrintMinimalScreen(&out, ScreenInput{CodexVersion: "1.2.3", CodexTarget: "1.2.4", QuotaRows: []QuotaRow{{Label: "weekly", Used: 45, Stale: true}}, QuotaWarn: "Last report needs refresh."})
	for _, want := range []string{"codex=1.2.3->1.2.4", "quota | weekly=45%", "stale=true", "warning | Last report needs refresh."} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("persona adapter dropped %q: %s", want, out.String())
		}
	}
}

func TestSkipBannerRemainsEngineScoped(t *testing.T) {
	t.Setenv("CDX_SKIP_BANNER", "")
	t.Setenv("CLX_SKIP_BANNER", "1")
	if sharedScreen(ScreenInput{}).SkipBanner {
		t.Fatal("Claude banner setting leaked to Codex")
	}
	t.Setenv("CDX_SKIP_BANNER", "1")
	if !sharedScreen(ScreenInput{}).SkipBanner {
		t.Fatal("Codex banner setting was ignored")
	}
}
