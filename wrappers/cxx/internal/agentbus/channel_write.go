package agentbus

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"time"
)

var errMCPWriterPoisoned = errors.New("MCP writer is fenced after an uncertain partial write")

type deadlineWriter interface{ SetWriteDeadline(time.Time) error }

// managedMCPWriter prepares the exclusive MCP stdout before any writer starts.
// Claude/Bun supplies a blocking socketpair: os.Stdout's inherited NewFile is
// not registered with Go's poller. FileConn owns a duplicate with real deadlines.
// Its O_NONBLOCK flag is shared with the borrowed stdout, so ALL protocol writes
// must use this returned writer; stdin and the borrowed descriptor are not closed.
// Already pollable writers are borrowed unchanged. Blocking pipes stay unsupported.
func managedMCPWriter(stdout io.Writer) (*mcpWriter, func()) {
	output := &mcpWriter{w: stdout}
	noop := func() {}
	if output.supportsGuardedWrite() {
		return output, noop
	}
	file, ok := stdout.(*os.File)
	if !ok {
		return output, noop
	}
	info, err := file.Stat()
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return output, noop
	}
	connection, err := net.FileConn(file)
	if err != nil {
		return output, noop
	}
	return &mcpWriter{w: connection}, func() { _ = connection.Close() }
}

// The broker holds the hook-ordering lock only for a bounded interval. An
// asynchronous or unbounded stdout write could outlive that lock and insert an
// after-turn message into a later active turn. Require a real writer deadline
// and never queue behind another MCP write.
func (w *mcpWriter) sendGuarded(ctx context.Context, deadline time.Time, value any) (attempted bool, err error) {
	if !w.mu.TryLock() {
		return false, errors.New("channel writer busy")
	}
	defer w.mu.Unlock()
	defer func() {
		if attempted && err != nil {
			w.poisoned = true
		}
	}()
	if w.poisoned {
		return false, errMCPWriterPoisoned
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if deadline.IsZero() || !time.Now().Before(deadline) {
		return false, errors.New("channel write boundary expired")
	}
	writer, ok := w.w.(deadlineWriter)
	if !ok {
		return false, errors.New("channel writer has no bounded write support")
	}
	if err := writer.SetWriteDeadline(deadline); err != nil {
		return false, errors.New("channel writer deadline unsupported")
	}
	defer func() {
		if resetErr := writer.SetWriteDeadline(time.Time{}); resetErr != nil && err == nil {
			err = errors.New("channel writer deadline reset failed")
		}
	}()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return true, writeJSON(w.w, value)
}

// Passive capability check: setting and clearing a deadline writes no frame.
func (w *mcpWriter) supportsGuardedWrite() bool {
	if w == nil || !w.mu.TryLock() {
		return false
	}
	defer w.mu.Unlock()
	if w.poisoned {
		return false
	}
	writer, ok := w.w.(deadlineWriter)
	if !ok {
		return false
	}
	if writer.SetWriteDeadline(time.Now().Add(time.Second)) != nil {
		return false
	}
	return writer.SetWriteDeadline(time.Time{}) == nil
}
