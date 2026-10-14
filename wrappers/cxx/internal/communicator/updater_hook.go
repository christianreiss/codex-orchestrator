package communicator

import (
	"context"
	"sync"
)

// UpdateProtocol is the signed push-triggered updater capability.
const UpdateProtocol = 1

// controlWrapperUpdate in ready.control says the server sends payload-free
// update_available triggers. A trigger is never trusted for a target: the
// updater reads it from the signed configuration and the host's cron check.
const controlWrapperUpdate = "wrapper_update"

// UpdateStatus is the updater's self-report, shown by status/doctor.
type UpdateStatus struct {
	State   string `json:"state"`
	Target  string `json:"target,omitempty"`
	Running string `json:"running,omitempty"`
	Agents  int    `json:"agents,omitempty"`
	Reason  string `json:"reason,omitempty"`
	At      string `json:"at,omitempty"`
}

// UpdaterEnv is what the owner lends the injected updater. It deliberately
// exposes no transport or credential state.
type UpdaterEnv interface {
	// Trigger fires on a pushed update_available and on every (re)connect.
	Trigger() <-chan struct{}
	ConfigPath() string
	Version() string
	// Busy counts finite owner work and accepted remote execution; native
	// sessions are checked by the updater itself (agentquiet).
	Busy() int
	Resident() bool
	Report(UpdateStatus)
	// Retire drains and ends an on-demand owner after a committed update so
	// the next managed call starts the new binary. Residents are replaced by
	// the root handoff instead and ignore it.
	Retire()
}

// Updater runs for the life of an owner whose signed config carries
// communicator_update_protocol. The cxx command registers it; the communicator
// package cannot import the installer (which imports this package).
type Updater func(ctx context.Context, env UpdaterEnv)

var (
	updaterMu         sync.Mutex
	registeredUpdater Updater
)

func RegisterUpdater(u Updater) {
	updaterMu.Lock()
	registeredUpdater = u
	updaterMu.Unlock()
}

func currentUpdater() Updater {
	updaterMu.Lock()
	defer updaterMu.Unlock()
	return registeredUpdater
}

type ownerUpdaterEnv struct {
	s    *server
	path string
}

func (e ownerUpdaterEnv) Trigger() <-chan struct{} { return e.s.updateTrigger }
func (e ownerUpdaterEnv) ConfigPath() string       { return e.path }
func (e ownerUpdaterEnv) Version() string          { return e.s.version }
func (e ownerUpdaterEnv) Resident() bool           { return e.s.resident.Load() }
func (e ownerUpdaterEnv) Report(st UpdateStatus) {
	e.s.mu.Lock()
	e.s.updateStatus = &st
	e.s.mu.Unlock()
}
func (e ownerUpdaterEnv) Retire() {
	if e.s.resident.Load() || e.s.stop == nil {
		return
	}
	e.s.draining.Store(true)
	e.s.stop()
}
func (e ownerUpdaterEnv) Busy() int {
	busy := 0
	if state := e.s.residentState; state != nil && state.controller != nil {
		state.mu.Lock()
		status := state.controller.Status()
		state.mu.Unlock()
		if !status.Verified || !status.Workload.Quiet() {
			busy++
		}
	}
	e.s.mu.Lock()
	defer e.s.mu.Unlock()
	busy += e.s.active + len(e.s.syncCalls)
	for _, scope := range e.s.scopes {
		if scope.running || len(scope.gate) != 0 || len(scope.authGate) != 0 {
			busy++
		}
	}
	return busy
}

// triggerUpdate wakes the updater without blocking; triggers coalesce.
func (s *server) triggerUpdate() {
	if s.updateTrigger == nil {
		return
	}
	select {
	case s.updateTrigger <- struct{}{}:
	default:
	}
}

func (s *server) startUpdater(ctx context.Context, path string) {
	updater := currentUpdater()
	if updater == nil || s.cfg == nil || s.cfg.Orchestrator.CommunicatorUpdateProtocol != UpdateProtocol {
		return
	}
	s.updateTrigger = make(chan struct{}, 1)
	s.triggerUpdate()
	go updater(ctx, ownerUpdaterEnv{s: s, path: path})
}
