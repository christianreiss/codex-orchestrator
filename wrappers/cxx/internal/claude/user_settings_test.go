package claude

import "testing"

func TestUserSettingsPerModelEffort(t *testing.T) {
	raw := []byte(`{"model":"claude-opus-5-5","effortLevel":"low","modelSettings":{"claude-opus-5-5":{"effortLevel":"xhigh","autoCompactWindow":300000},"claude-sonnet-4-6":{"effortLevel":"medium"}}}`)
	for _, tc := range []struct{ selected, effort string }{
		{"", "xhigh"}, {"claude-opus-5-5[1m]", "xhigh"}, {"claude-sonnet-4-6", "medium"},
		{"claude-haiku-5-5", ""}, {"claude-opus-4-7", "low"},
	} {
		model, effort := UserSettingsPreferences(raw, tc.selected)
		if model != "claude-opus-5-5" || effort != tc.effort {
			t.Fatalf("selected %q = %q / %q", tc.selected, model, effort)
		}
	}
}
