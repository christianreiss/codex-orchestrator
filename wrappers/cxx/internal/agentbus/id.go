package agentbus

import (
	"crypto/rand"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativewriter"
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
	return nativewriter.Path(engine, nativeSessionID)
}
