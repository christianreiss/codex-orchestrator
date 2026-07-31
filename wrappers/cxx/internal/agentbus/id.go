package agentbus

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func newUUID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(fmt.Sprintf("agent messaging random UUID: %v", err))
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

func writerLockPath(engine, nativeSessionID string) (string, error) {
	engine = strings.ToLower(strings.TrimSpace(engine))
	if engine != "codex" && engine != "claude" {
		return "", fmt.Errorf("unsupported engine %q", engine)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("determine home directory: %w", err)
	}
	digest := sha256.Sum256([]byte(nativeSessionID))
	return filepath.Join(home, ".cxx", "agent", "locks", engine+"-"+hex.EncodeToString(digest[:])[:24]+".lock"), nil
}
