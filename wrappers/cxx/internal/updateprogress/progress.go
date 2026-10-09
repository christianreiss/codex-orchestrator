// Package updateprogress carries optional update observations without coupling
// installers to a terminal or changing unattended maintenance output.
package updateprogress

import (
	"context"
	"io"
)

type Event struct {
	Phase string
	Bytes int64
	Total int64 // <= 0 means unknown, never an estimated percentage
}

type Observer func(Event)
type observerKey struct{}
type outputKey struct{}

func WithObserver(ctx context.Context, observer Observer) context.Context {
	return context.WithValue(ctx, observerKey{}, observer)
}

func Emit(ctx context.Context, event Event) {
	if observer, ok := ctx.Value(observerKey{}).(Observer); ok && observer != nil {
		observer(event)
	}
}

// WithOutput lets a caller own presentation while retaining returned errors.
func WithOutput(ctx context.Context, output io.Writer) context.Context {
	return context.WithValue(ctx, outputKey{}, output)
}

func Output(ctx context.Context, fallback io.Writer) io.Writer {
	if output, ok := ctx.Value(outputKey{}).(io.Writer); ok {
		return output
	}
	return fallback
}

func Reader(ctx context.Context, source io.Reader, total int64) io.Reader {
	if observer, ok := ctx.Value(observerKey{}).(Observer); !ok || observer == nil {
		return source
	}
	Emit(ctx, Event{Phase: "downloading", Total: total})
	return &reader{ctx: ctx, source: source, total: total}
}

type reader struct {
	ctx          context.Context
	source       io.Reader
	bytes, total int64
}

func (r *reader) Read(p []byte) (int, error) {
	n, err := r.source.Read(p)
	r.bytes += int64(n)
	Emit(r.ctx, Event{Phase: "downloading", Bytes: r.bytes, Total: r.total})
	return n, err
}
