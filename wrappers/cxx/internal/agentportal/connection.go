package agentportal

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// ConnectionRuntime owns the local connection capability for one native launch.
// Auth/account leases remain with the engine launch machinery.
type ConnectionRuntime struct {
	session       *Session
	broker        *Broker
	ctx           context.Context
	restore       func()
	stopWatchdog  func()
	stopHeartbeat func()
	once          sync.Once
	closeErr      error
}

// StartConnection may return both a usable runtime and a startup error: pending
// registrations retain the existing recovery behavior of Session.Start. A runtime
// is always returned, including disabled/failing registration, to keep inherited
// capabilities scrubbed until Close; Session may be nil.
func StartConnection(ctx context.Context, cfg *config.Config, input StartInput) (*ConnectionRuntime, error) {
	restore := ScrubEnvironment()
	session, startErr := Start(ctx, cfg, input)
	if session == nil {
		return &ConnectionRuntime{ctx: ctx, restore: restore, stopHeartbeat: func() {}}, startErr
	}
	session.watchdog = &watchdogFeed{}
	runtime := &ConnectionRuntime{session: session, ctx: session.WithScheduleWatch(ctx), restore: restore}
	runtime.stopWatchdog = session.startWatchdogFeed(runtime.ctx)
	broker, brokerErr := session.StartBroker(runtime.ctx)
	runtime.broker = broker
	if broker != nil {
		restoreBroker := broker.ActivateEnvironment()
		runtime.restore = func() { restoreBroker(); restore() }
	}
	runtime.stopHeartbeat = session.StartHeartbeat(runtime.ctx)
	return runtime, errors.Join(startErr, brokerErr)
}

func (r *ConnectionRuntime) Session() *Session {
	if r == nil {
		return nil
	}
	return r.session
}
func (r *ConnectionRuntime) Broker() *Broker {
	if r == nil {
		return nil
	}
	return r.broker
}
func (r *ConnectionRuntime) Context() context.Context { return r.ctx }
func (r *ConnectionRuntime) CodexMCPOverrides(headless bool) []string {
	if r == nil || r.broker == nil {
		return nil
	}
	return r.broker.CodexMCPOverrides(headless)
}

// Close releases the capability even if remote finalization fails. It never
// launches another session or retries execution to obtain a missing ACK.
func (r *ConnectionRuntime) Close(status, summary string) error {
	if r == nil {
		return nil
	}
	r.once.Do(func() {
		if r.stopWatchdog != nil {
			r.stopWatchdog()
		}
		if r.session != nil {
			r.session.watchdogExit(status, summary)
		}
		r.stopHeartbeat()
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		var heartbeatErr error
		if r.session != nil {
			heartbeatErr = r.session.Heartbeat(ctx, "", "close")
		}
		cancel()
		var brokerErr error
		if r.broker != nil {
			brokerErr = r.broker.Close()
		}
		r.restore()
		r.closeErr = errors.Join(heartbeatErr, brokerErr, r.session.Finish(status, summary))
	})
	return r.closeErr
}
