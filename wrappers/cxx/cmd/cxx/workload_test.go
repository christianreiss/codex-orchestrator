package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestWorkloadHelpBypassesFleetAndNativeBootForEveryEngine(t *testing.T) {
	for _, name := range []string{"cxx", "cdx", "clx", "cgx"} {
		t.Run(name, func(t *testing.T) {
			var out, err bytes.Buffer
			if code := run(name, []string{"workload", "--help"}, &out, &err); code != 0 || err.Len() != 0 || !strings.Contains(out.String(), "cooperative jobs") {
				t.Fatalf("code=%d out=%s err=%s", code, out.String(), err.String())
			}
		})
	}
}
