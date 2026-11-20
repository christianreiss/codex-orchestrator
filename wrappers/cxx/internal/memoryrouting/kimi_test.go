package memoryrouting

import (
	"path/filepath"
	"strings"
	"testing"
)

// Kimi routes the reminder into its global AGENTS.md, which the ownership
// manifest then records. A later sync must accept that recorded target instead
// of rejecting the manifest, and a tracked AGENTS.md anywhere else stays
// refused.
func TestKimiReapplyAcceptsTrackedAgentsFile(t *testing.T) {
	home := t.TempDir()
	agents := filepath.Join(home, "AGENTS.md")
	write(t, agents, []byte("# Fleet instructions\n"))
	bundle := &Bundle{Enabled: true, Content: "Use shared_memory_search over MCP"}
	if changed, err := Apply("kimi", home, bundle, nil); !changed || err != nil {
		t.Fatalf("first apply = %v, %v", changed, err)
	}
	if changed, err := Apply("kimi", home, bundle, nil); changed || err != nil {
		t.Fatalf("second apply = %v, %v", changed, err)
	}
	if body := string(read(t, agents)); !strings.HasPrefix(body, Start+"\n") || !strings.HasSuffix(body, "# Fleet instructions\n") {
		t.Fatalf("AGENTS.md = %q", body)
	}
	if changed, err := Apply("kimi", home, &Bundle{Enabled: false}, nil); !changed || err != nil {
		t.Fatalf("disable = %v, %v", changed, err)
	}
	if body := string(read(t, agents)); body != "# Fleet instructions\n" {
		t.Fatalf("AGENTS.md after disable = %q", body)
	}

	foreign := t.TempDir()
	write(t, filepath.Join(foreign, manifestName), []byte(`["`+filepath.Join(t.TempDir(), "AGENTS.md")+`"]`))
	if _, err := Apply("kimi", foreign, bundle, nil); err == nil || !strings.Contains(err.Error(), "ownership path") {
		t.Fatalf("foreign tracked AGENTS.md accepted: %v", err)
	}
}
