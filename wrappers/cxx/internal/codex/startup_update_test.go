package codex

import (
	"reflect"
	"testing"
)

func TestStartupUpdateOverrideWinsBeforePromptBoundary(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want []string
	}{
		{"interactive", nil, []string{"-c", "check_for_update_on_startup=false"}},
		{"resume with explicit enable", []string{"resume", "session", "--config=check_for_update_on_startup=true"}, []string{"resume", "session", "--config=check_for_update_on_startup=true", "-c", "check_for_update_on_startup=false"}},
		{"execute prompt", []string{"exec", "a prompt"}, []string{"exec", "a prompt", "-c", "check_for_update_on_startup=false"}},
		{"literal prompt flags", []string{"--config", "check_for_update_on_startup=true", "exec", "--", "-c", "check_for_update_on_startup=true"}, []string{"--config", "check_for_update_on_startup=true", "exec", "-c", "check_for_update_on_startup=false", "--", "-c", "check_for_update_on_startup=true"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := append([]string(nil), tc.args...)
			got := disableStartupUpdateCheck(tc.args)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("native args = %#v, want %#v", got, tc.want)
			}
			if !reflect.DeepEqual(tc.args, before) {
				t.Fatal("modified caller arguments")
			}
		})
	}
}
