// Package nativeprocess preserves catchable shutdown signals while bounding
// native child cleanup. Auth and session leases remain owned by the caller.
package nativeprocess

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"time"

	"golang.org/x/term"
)

const Grace = 10 * time.Second

type signalCause struct{ signal os.Signal }

func (s signalCause) Error() string { return "interrupted by " + s.signal.String() }

// NotifyContext retains the actual signal, unlike signal.NotifyContext. The
// CommandContext cancellation path can then forward it without racing a second
// signal handler that would otherwise compete with Process.Kill.
func NotifyContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancelCause(parent)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, terminationSignals()...)
	go func() {
		select {
		case sig := <-signals:
			cancel(signalCause{sig})
		case <-ctx.Done():
		}
	}()
	return ctx, func() { signal.Stop(signals); cancel(context.Canceled) }
}

// Headless keeps terminal readers in the inherited foreground process group.
// Moving those readers into a background group would stop them with SIGTTIN.
func Headless(stdin io.Reader) bool {
	file, ok := stdin.(*os.File)
	return !ok || !term.IsTerminal(int(file.Fd()))
}

type Supervisor struct {
	ctx    context.Context
	cmd    *exec.Cmd
	group  bool
	mu     sync.Mutex
	timer  *time.Timer
	closed bool
}

// Prepare must precede Start. Close must follow Wait (and also run on start
// failures). Only noninteractive children may own a separate process group.
func Prepare(ctx context.Context, cmd *exec.Cmd, group bool) *Supervisor {
	return prepare(ctx, cmd, group, Grace)
}

// PrepareWithGrace lets an outer wrapper supervisor give the inner native
// supervisor time to finish its own bounded shutdown before killing the wrapper.
func PrepareWithGrace(ctx context.Context, cmd *exec.Cmd, group bool, grace time.Duration) *Supervisor {
	return prepare(ctx, cmd, group, grace)
}

func prepare(ctx context.Context, cmd *exec.Cmd, group bool, grace time.Duration) *Supervisor {
	s := &Supervisor{ctx: ctx, cmd: cmd, group: group}
	if group {
		prepareGroup(cmd)
	}
	cmd.WaitDelay = grace + time.Second
	cmd.Cancel = func() error {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.closed {
			return os.ErrProcessDone
		}
		sig := terminateSignal()
		var cause signalCause
		if errors.As(context.Cause(ctx), &cause) {
			sig = cause.signal
		}
		err := sendSignal(cmd, group, sig)
		if s.timer == nil {
			s.timer = time.AfterFunc(grace, func() {
				s.mu.Lock()
				defer s.mu.Unlock()
				if !s.closed {
					_ = sendSignal(cmd, group, os.Kill)
				}
			})
		}
		return err
	}
	return s
}

// Close also reaps descendants left in an owned group after its leader exits.
// It never signals an inherited foreground group, which may contain the shell.
func (s *Supervisor) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	if s.timer != nil {
		s.timer.Stop()
	}
	if s.group && s.cmd.Process != nil {
		_ = sendSignal(s.cmd, true, os.Kill)
	}
}

// Result preserves conventional 128+signal exits and the operator's original
// signal even when a child needs forced cleanup after the grace period.
func (s *Supervisor) Result(err error) (int, error) {
	var cause signalCause
	if errors.As(context.Cause(s.ctx), &cause) {
		return signalExit(cause.signal), nil
	}
	if err == nil {
		return 0, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exitCode(exit), nil
	}
	return 1, err
}
