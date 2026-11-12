//go:build linux

package schedulewatch

import "testing"

func TestKimiNativeProcessMatching(t *testing.T) {
	for _, tc := range []struct {
		cmd  string
		want bool
	}{{"/private/bin/kimi\x00-p\x00probe", true}, {"kimi\x00", true}, {"/bin/sh\x00kimi\x00", false}, {"/tmp/kimi-tool\x00", false}} {
		if got := isKimiProcess([]byte(tc.cmd)); got != tc.want {
			t.Fatal(tc.cmd, got)
		}
	}
}
