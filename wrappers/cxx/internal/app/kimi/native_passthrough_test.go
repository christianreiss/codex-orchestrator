package kimi

import (
	"slices"
	"testing"
)

func TestKimiNativeUpdateCommandBoundary(t *testing.T) {
	t.Setenv("CKX_CONFIG_PATH", t.TempDir()+"/ckx.json")
	// These words are unknown native commands in 2.5.3 and 2.7.2. They may
	// also be prompt text. Only the real update commands belong to the wrapper.
	for _, args := range [][]string{
		{"setup"}, {"install"}, {"--prompt", "setup"}, {"--prompt", "install"},
		{"setup", "--help"}, {"install", "--help"}, {"upgrade", "--help"},
	} {
		opts, err := nativeOptions(args)
		if err != nil || opts.command != "run" || !slices.Equal(opts.args, args) || managedNativeRefusal(args) != "" {
			t.Errorf("native argv %q was not preserved: %+v, %v", args, opts, err)
		}
	}
	for _, command := range []string{"upgrade", "update"} {
		if _, err := nativeOptions([]string{command}); err == nil || err.Error() != installRefusal {
			t.Errorf("%s: expected fleet update guidance, got %v", command, err)
		}
	}
}
