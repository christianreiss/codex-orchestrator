package agentportal

import (
	"bytes"
	"testing"
)

func TestCommandDiscoveryAndBadPositionalsNeverReachSession(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_SOCKET", "/missing/socket")
	for _, command := range []string{"status", "notify", "resolve", "say", "ask", "wait", "accept", "leave"} {
		for _, help := range []string{"--help", "-h"} {
			var out, errout bytes.Buffer
			if code := RunCommand([]string{command, help}, &out, &errout); code != 0 || out.Len() == 0 || errout.Len() != 0 {
				t.Fatalf("%s %s: code=%d out=%s err=%s", command, help, code, &out, &errout)
			}
		}
	}
	for _, args := range [][]string{{"leave", "stray"}, {"status", "stray"}, {"notify", "--summary", "hi", "stray"}, {"resolve", "--summary", "hi", "stray"}, {"say", "--text", "hi", "stray", "--summary", "lost"}, {"ask", "--question", "hi", "stray"}, {"wait", "stray"}, {"accept", "--message-id", "id", "--lease-owner", "lease", "stray"}} {
		var out, errout bytes.Buffer
		if code := RunCommand(args, &out, &errout); code != 2 || out.Len() != 0 {
			t.Fatalf("%v: code=%d out=%s err=%s", args, code, &out, &errout)
		}
	}
}
