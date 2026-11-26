package claude

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// EnrollmentEnv is the environment for a native `claude auth login` that adds
// another fleet account. Every inherited credential or provider selector is
// removed, exactly as for a managed launch, and CLAUDE_CONFIG_DIR points the
// native CLI at a private directory so ~/.claude and running sessions are
// never touched.
func EnrollmentEnv(configDir string) []string {
	env := filterEnv(os.Environ(), runtimeAuthOverrideEnv)
	return append(env, "CLAUDE_CONFIG_DIR="+configDir)
}

// EnrollmentUpload reads the credentials a native login wrote into configDir
// and returns the fleet upload envelope (native OAuth block plus a fresh
// last_refresh stamp). It never reads or writes ~/.claude.
func EnrollmentUpload(configDir string) (json.RawMessage, error) {
	raw, err := os.ReadFile(filepath.Join(configDir, ".credentials.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("the native login wrote no credentials file (a keychain-only login cannot be enrolled)")
	}
	if err != nil {
		return nil, err
	}
	native, err := extractClaudeFormat(raw)
	if err != nil {
		return nil, fmt.Errorf("enrolled credentials are not usable: %w", err)
	}
	if !isUsableAuth(native) || !hasNativeClaudeOAuth(native) {
		return nil, errors.New("enrolled credentials contain no Claude subscription login")
	}
	return withLastRefresh(native, time.Now().UTC().Format(time.RFC3339Nano))
}
