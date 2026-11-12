package agentportal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// Kimi binds --agent-file at session creation and refuses it on resume. A
// per-launch AGENTS.md overlay preserves the selected native agent and applies
// the current launch identity both to new sessions and resumed sessions.
func AppendKimiIdentityArgs(args []string, identity Identity, runtimeHome string) ([]string, error) {
	if identity.Name == "" {
		return args, nil
	}
	if runtimeHome == "" || !filepath.IsAbs(runtimeHome) {
		return nil, fmt.Errorf("Kimi identity requires an absolute private KIMI_CODE_HOME")
	}
	path := filepath.Join(runtimeHome, "AGENTS.md")
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	const marker = "\n<!-- cxx:launch-identity:start -->\n"
	const end = "\n<!-- cxx:launch-identity:end -->\n"
	body := string(raw)
	if start := strings.Index(body, marker); start >= 0 {
		stop := strings.Index(body[start+len(marker):], end)
		if stop < 0 {
			return nil, fmt.Errorf("Kimi identity overlay is incomplete")
		}
		body = body[:start] + body[start+len(marker)+stop+len(end):]
	}
	body += marker + identity.Context() + end
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		return nil, err
	}
	return args, nil
}

func kimiResumeID(args []string) string {
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			break
		}
		flag, value, inline := strings.Cut(args[i], "=")
		switch flag {
		case "-S", "--session", "-r", "--resume":
			if !inline && i+1 < len(args) {
				i++
				value = args[i]
			}
			if validKimiNativeID(value) {
				return value
			}
			return ""
		case "-p", "--prompt", "-m", "--model", "--agent", "--agent-file", "--output-format", "--skills-dir", "--add-dir", "--environment", "--environment-cwd":
			if !inline {
				i++
			}
		}
	}
	return ""
}
func validKimiNativeID(id string) bool {
	return strings.HasPrefix(id, "session_") && isCanonicalUUID(strings.TrimPrefix(id, "session_"))
}

// Keep this slice buildable against the common base, before wrapper-core adds
// the typed field. Decode only the same canonical JSON key it will provide.
func kimiModelOverride(cfg *config.Config) *string {
	raw, _ := json.Marshal(cfg.EngineOptions)
	var options struct {
		Model *string `json:"kimi_model_override"`
	}
	_ = json.Unmarshal(raw, &options)
	return options.Model
}

func validNativeIdentity(engine, id string) bool {
	switch engine {
	case "kimi":
		return validKimiNativeID(id)
	case "codex", "claude", "grok":
		return isCanonicalUUID(id)
	default:
		return false
	}
}
