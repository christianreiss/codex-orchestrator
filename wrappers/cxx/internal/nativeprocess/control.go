package nativeprocess

import (
	"context"
	"os"
	"sync"
	"time"
)

type controlKey struct{}
type ControlStarter func(stop func() error) (finish func())

// WithControl attaches a launch-scoped controller. No PID is accepted remotely.
func WithControl(ctx context.Context, start ControlStarter) context.Context {
	return context.WithValue(ctx, controlKey{}, start)
}

// StartControl is called only after Start succeeds. Close must follow Wait.
func (s *Supervisor) StartControl() {
	start, ok := s.ctx.Value(controlKey{}).(ControlStarter)
	if !ok {
		return
	}
	var once sync.Once
	s.finishControl = start(func() (err error) {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.closed {
				err = os.ErrProcessDone
				return
			}
			err = sendSignal(s.cmd, s.group, terminateSignal())
			if err != nil {
				return
			}
			if s.timer != nil {
				s.timer.Stop()
			}
			s.timer = time.AfterFunc(5*time.Second, func() {
				s.mu.Lock()
				defer s.mu.Unlock()
				if !s.closed {
					_ = sendSignal(s.cmd, s.group, os.Kill)
				}
			})
		})
		return err
	})
}
