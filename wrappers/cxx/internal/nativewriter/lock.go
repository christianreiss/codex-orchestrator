package nativewriter

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"os"
	"path/filepath"
	"strings"
)

func Path(engine, session string) (string, error) {
	engine = strings.ToLower(strings.TrimSpace(engine))
	if engine != "codex" && engine != "claude" && engine != "grok" {
		return "", fmt.Errorf("unsupported engine %q", engine)
	}
	home, e := os.UserHomeDir()
	if e != nil {
		return "", e
	}
	digest := sha256.Sum256([]byte(session))
	return filepath.Join(home, ".cxx", "agent", "locks", engine+"-"+hex.EncodeToString(digest[:])[:24]+".lock"), nil
}
func Acquire(engine, session string) (*ipc.Lock, error) {
	p, e := Path(engine, session)
	if e != nil {
		return nil, e
	}
	return ipc.TryAcquireExclusivePath(p)
}
