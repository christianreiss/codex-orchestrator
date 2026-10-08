// Package schedulewatch supervises only a Cmd owned by this wrapper. An absent,
// stale or unavailable policy never grants permission to terminate a process.
package schedulewatch

import (
	"context"
	"golang.org/x/term"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

type Policy struct {
	TimeoutSeconds    int `json:"progress_timeout_seconds"`
	BindingGeneration int `json:"binding_generation"`
}

var pollInterval = 5 * time.Second

type PolicyReader func(context.Context) (Policy, error)
type key struct{}
type Watch struct {
	mu   sync.Mutex
	last time.Time
	read PolicyReader
}

func WithPolicy(ctx context.Context, read PolicyReader) context.Context {
	return context.WithValue(ctx, key{}, &Watch{last: time.Now(), read: read})
}
func watch(ctx context.Context) *Watch { w, _ := ctx.Value(key{}).(*Watch); return w }
func Touch(ctx context.Context) {
	if w := watch(ctx); w != nil {
		w.mu.Lock()
		w.last = time.Now()
		w.mu.Unlock()
	}
}

type progressWriter struct {
	ctx  context.Context
	next io.Writer
}

func (w progressWriter) Write(p []byte) (int, error) {
	n, e := w.next.Write(p)
	if n > 0 {
		Touch(w.ctx)
	}
	return n, e
}
func Writer(ctx context.Context, next io.Writer) io.Writer {
	if file, ok := next.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		return next
	}
	if watch(ctx) == nil {
		return next
	}
	return progressWriter{ctx, next}
}

// Start monitors a started child. stop must be called immediately after Wait.
// Signals use the original os.Process handle, never a PID discovered remotely.
func Start(ctx context.Context, cmd *exec.Cmd) func() {
	w := watch(ctx)
	if w == nil || w.read == nil || cmd == nil || cmd.Process == nil {
		return func() {}
	}
	childCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	baseline := activity(cmd.Process.Pid)
	go func() {
		defer close(done)
		ticker := time.NewTicker(pollInterval)
		defer ticker.Stop()
		generation := 0
		for {
			select {
			case <-childCtx.Done():
				return
			case <-ticker.C:
				current := activity(cmd.Process.Pid)
				if current.known && (current.cpu != baseline.cpu || current.tool) {
					Touch(ctx)
				}
				baseline = current
				request, c := context.WithTimeout(childCtx, 4*time.Second)
				policy, err := w.read(request)
				c()
				if err != nil || policy.TimeoutSeconds <= 0 || !current.known {
					Touch(ctx)
					generation = 0
					continue
				}
				if generation != policy.BindingGeneration {
					Touch(ctx)
					generation = policy.BindingGeneration
					continue
				}
				w.mu.Lock()
				stalled := time.Since(w.last) >= time.Duration(policy.TimeoutSeconds)*time.Second
				w.mu.Unlock()
				if !stalled {
					continue
				}
				// Fresh authorization immediately before TERM. Lost binding resets the clock.
				request, c = context.WithTimeout(childCtx, 4*time.Second)
				fresh, err := w.read(request)
				c()
				if err != nil || fresh.TimeoutSeconds != policy.TimeoutSeconds || fresh.BindingGeneration != generation {
					Touch(ctx)
					continue
				}
				_ = terminate(cmd.Process)
				timer := time.NewTimer(10 * time.Second)
				select {
				case <-childCtx.Done():
					timer.Stop()
					return
				case <-timer.C:
					_ = cmd.Process.Kill()
					return
				}
			}
		}
	}()
	return func() { cancel(); <-done }
}
