package communicator

import (
	"slices"
	"testing"
)

// An owner spawned during a `cxx update` continuation, a cron re-exec or a
// post-update wrapper re-exec must not inherit that process's one-shot
// hand-off markers: with CXX_UPDATE_WRAPPER_DONE=<own version> the owner's
// later `cxx update --minimal` would skip the wrapper step and still report
// the release as applied.
func TestCommunicatorEnvironmentDropsUpdateAndCronHandOffMarkers(t *testing.T) {
	handOff := []string{
		"CXX_UPDATE_WRAPPER_DONE=0.9.200",
		"CODEX_WRAPPER_RESTARTED=1", "CLAUDE_WRAPPER_RESTARTED=1", "CGX_WRAPPER_RESTARTED=1", "CKX_WRAPPER_RESTARTED=1",
		"CODEX_WRAPPER_RESTART_DEPTH=1", "CLAUDE_WRAPPER_RESTART_DEPTH=2",
		"CXX_CRON_ENGINE_ONLY=1", "CXX_CRON_COORDINATED=1",
		"CDX_AUTH_SESSION_HANDOFF=e30", "CLX_AUTH_SESSION_HANDOFF=e30",
	}
	kept := []string{
		"HOME=/home/fixture", "PATH=/usr/bin:/bin", "CDX_CONFIG_PATH=/etc/cdx.json",
		"CXX_MCP_BEARER=fixture", "CXX_UPDATE_WRAPPER_DONE_NOTE=unrelated",
	}
	got := communicatorEnvironment(append(append([]string{"CXX_AGENT_ID=x"}, handOff...), kept...))
	for _, entry := range handOff {
		if slices.Contains(got, entry) {
			t.Errorf("owner environment kept hand-off marker %s", entry)
		}
	}
	for _, entry := range kept {
		if !slices.Contains(got, entry) {
			t.Errorf("owner environment lost %s", entry)
		}
	}
	if slices.Contains(got, "CXX_AGENT_ID=x") {
		t.Error("owner environment kept a CXX_AGENT_ prefix variable")
	}
}
