// Package schedulewatch supervises only a Cmd owned by this wrapper. An absent,
// stale or unavailable policy never grants permission to terminate a process.
package schedulewatch

import (
	"context"
	"encoding/json"
	"golang.org/x/term"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type Policy struct {
	TimeoutSeconds     int  `json:"progress_timeout_seconds"`
	BindingGeneration  int  `json:"binding_generation"`
	TerminateRequested bool `json:"terminate_requested"`
}

var pollInterval = 5 * time.Second

type PolicyReader func(context.Context) (Policy, error)
type key struct{}
type Watch struct {
	mu       sync.Mutex
	last     time.Time
	read     PolicyReader
	progress time.Time
	report   func(context.Context, time.Time, string) error
}

func WithPolicy(ctx context.Context, read PolicyReader) context.Context {
	return context.WithValue(ctx, key{}, &Watch{last: time.Now(), progress: time.Now(), read: read})
}
func WithReporter(ctx context.Context, report func(context.Context, time.Time, string) error) context.Context {
	if w := watch(ctx); w != nil {
		w.report = report
	}
	return ctx
}
func ReportFailure(ctx context.Context, failure string) {
	if w := watch(ctx); w != nil && w.report != nil {
		request, cancel := context.WithTimeout(ctx, 4*time.Second)
		defer cancel()
		w.mu.Lock()
		p := w.progress
		w.mu.Unlock()
		_ = w.report(request, p, failure)
	}
}
func watch(ctx context.Context) *Watch { w, _ := ctx.Value(key{}).(*Watch); return w }
func Touch(ctx context.Context) {
	if w := watch(ctx); w != nil {
		w.mu.Lock()
		w.last = time.Now()
		w.progress = w.last
		w.mu.Unlock()
	}
}

func reset(ctx context.Context) {
	if w := watch(ctx); w != nil {
		w.mu.Lock()
		w.last = time.Now()
		w.mu.Unlock()
	}
}

// CapacityFailure requires a provider error shape; conversational mentions do not count.
func CapacityFailure(raw []byte) bool {
	var event map[string]any
	if json.Unmarshal(raw, &event) != nil {
		return false
	}
	typ, _ := event["type"].(string)
	_, hasError := event["error"]
	failed, _ := event["is_error"].(bool)
	if !hasError && !failed && typ != "error" {
		return false
	}
	text := strings.ToLower(string(raw))
	return strings.Contains(text, "at capacity") || strings.Contains(text, "rate_limit") || strings.Contains(text, "overloaded") || strings.Contains(text, "usage limit") || strings.Contains(text, "quota limit")
}

type progressWriter struct {
	ctx     context.Context
	next    io.Writer
	mu      sync.Mutex
	pending []byte
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n, e := w.next.Write(p)
	if n > 0 {
		w.mu.Lock()
		w.pending = append(w.pending, p[:n]...)
		if len(w.pending) > 65536 {
			w.pending = nil
		}
		failure := false
		for {
			line, rest, ok := strings.Cut(string(w.pending), "\n")
			if !ok {
				break
			}
			if CapacityFailure([]byte(line)) {
				failure = true
			}
			w.pending = []byte(rest)
		}
		if CapacityFailure(w.pending) {
			failure = true
			w.pending = nil
		}
		w.mu.Unlock()
		Touch(w.ctx)
		if failure {
			ReportFailure(w.ctx, "capacity")
		}
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
	return &progressWriter{ctx: ctx, next: next}
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
				if w.report != nil {
					w.mu.Lock()
					progress := w.progress
					w.mu.Unlock()
					request, c := context.WithTimeout(childCtx, 4*time.Second)
					_ = w.report(request, progress, "")
					c()
				}
				request, c := context.WithTimeout(childCtx, 4*time.Second)
				policy, err := w.read(request)
				c()
				if err != nil || policy.TimeoutSeconds <= 0 || !current.known {
					reset(ctx)
					generation = 0
					continue
				}
				if generation != policy.BindingGeneration {
					reset(ctx)
					generation = policy.BindingGeneration
					continue
				}
				w.mu.Lock()
				stalled := time.Since(w.last) >= time.Duration(policy.TimeoutSeconds)*time.Second
				w.mu.Unlock()
				stalled = stalled || (policy.TerminateRequested && !current.tool)
				if !stalled {
					continue
				}
				if !policy.TerminateRequested {
					ReportFailure(ctx, "hang")
				}
				// Fresh authorization immediately before TERM. Lost binding resets the clock.
				request, c = context.WithTimeout(childCtx, 4*time.Second)
				fresh, err := w.read(request)
				c()
				if err != nil || fresh.TimeoutSeconds != policy.TimeoutSeconds || fresh.BindingGeneration != generation || (policy.TerminateRequested && !fresh.TerminateRequested) {
					reset(ctx)
					continue
				}
				if activity(cmd.Process.Pid).tool {
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
