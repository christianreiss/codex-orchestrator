// Package agentquiet answers "is any agent running for this OS user?" for the
// updater's quiet gate. Every managed native launch (local, remote-daemon or
// legacy) holds its engine's shared housekeeping lock for the native child's
// whole life (sessionguard.Launch), so an exclusive probe that succeeds proves
// no native session of that engine is running.
package agentquiet

import (
	"errors"
	"os"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
)

// Engines lists the engines checked by Busy.
var Engines = []string{"codex", "claude", "grok"}

// Busy returns the engines with a running native session. An engine whose
// native home does not exist has none. Any probe failure other than a held
// lock is reported as busy: an unproven quiet state never permits an update.
func Busy() []string {
	var busy []string
	for _, engine := range Engines {
		root, err := sessionguard.Root(engine)
		if err != nil {
			busy = append(busy, engine)
			continue
		}
		if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
			continue
		}
		lock, err := sessionguard.Maintenance(root)
		if err != nil {
			busy = append(busy, engine)
			continue
		}
		_ = lock.Release()
	}
	return busy
}

// DeferScheduledUpdates reports whether a scheduled maintenance tick must leave
// binary updates (wrapper swap and provider CLI pointer switch) to the
// communicator updater: with the signed update capability, binaries change
// only while no agent runs. Content and auth upkeep are unaffected, and an
// explicit `cxx update` is never deferred.
func DeferScheduledUpdates(updateProtocol int) bool {
	return updateProtocol == 1 && len(Busy()) > 0
}
