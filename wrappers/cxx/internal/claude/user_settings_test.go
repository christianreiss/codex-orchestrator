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

func TestFable52UsesOnlyItsOwnUserEffort(t *testing.T) {
	for _, model := range []string{"claude-fable-5-2", "claude-fable-5-2[1m]"} {
		for _, level := range []string{"", "high"} {
			raw := []byte(`{"model":"` + model + `","effortLevel":"low","modelSettings":{"claude-fable-5-2":{"effortLevel":"` + level + `"},"claude-fable-5-1":{"effortLevel":"xhigh"}}}`)
			for _, selection := range []string{"", model} {
				gotModel, effort := UserSettingsPreferences(raw, selection)
				if gotModel != model || effort != level {
					t.Fatalf("model %q selection %q effort=%q: got %q / %q", model, selection, level, gotModel, effort)
				}
			}
		}
	}
	// Older active Fable versions retain the legacy user preference.
	for _, model := range []string{"claude-fable-5-1", "claude-fable-5"} {
		_, effort := UserSettingsPreferences([]byte(`{"model":"`+model+`","effortLevel":"low"}`), "")
		if effort != "low" {
			t.Fatalf("legacy preference lost for %s", model)
		}
	}
}
