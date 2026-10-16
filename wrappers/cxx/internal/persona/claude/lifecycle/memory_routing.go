package lifecycle

import (
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
)

// memoryRoutingArgs forwards actual native settings selectors. Other flag
// values and literal prompt text cannot redirect the managed memory reminder.
func memoryRoutingArgs(args []string) []string {
	var selectors []string
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		end := claude.NativeOptionValueEnd(args, i)
		name, _, _ := strings.Cut(args[i], "=")
		if name == "--settings" || name == "--setting-sources" {
			selectors = append(selectors, args[i:end+1]...)
		}
		i = end
	}
	return selectors
}
