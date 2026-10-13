package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
)

func TestResidentFenceDrainsPermitsWithoutCancellingWork(t *testing.T) {
	c := NewResidentController("test", io.Discard, io.Discard)
	finish, ok := c.permit()
	if !ok {
		t.Fatal("initial admission refused")
	}
	c.Fence()
	if _, ok := c.permit(); ok {
		t.Fatal("fenced controller admitted work")
	}
	if got := c.Status(); got.Workload.PeerClaims != 1 || !got.Fenced {
		t.Fatalf("accepted permit lost: %+v", got)
	}
	finish()
	finish()
	if got := c.Status(); got.Workload.PeerClaims != 0 {
		t.Fatalf("permit release was not idempotent: %+v", got)
	}
}

func TestResidentFenceAndAdmissionAreAtomic(t *testing.T) {
	c := NewResidentController("test", io.Discard, io.Discard)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if finish, ok := c.permit(); ok {
				finish()
			}
		}()
	}
	c.Fence()
	wg.Wait()
	if got := c.Status(); got.Workload.PeerClaims != 0 {
		t.Fatalf("permit leak: %+v", got)
	}
	if _, ok := c.permit(); ok {
		t.Fatal("post-fence admission")
	}
}

func TestResidentStatusCountsAmbiguousJournalsAndRefusesUnknownState(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "receipts"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"operation.json", "deadline.json", "receipts/message.json"} {
		if err := os.WriteFile(filepath.Join(dir, path), []byte("partial"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	c := NewResidentController("test", io.Discard, io.Discard)
	c.started = true
	c.bindSnapshot(func() (residency.Workload, error) {
		n, err := verifiedPendingReceipts(dir)
		return residency.Workload{Receipts: n}, err
	})
	got := c.Status()
	if !got.Verified || got.Workload.Receipts != 2 || got.Workload.Quiet() {
		t.Fatalf("ambiguous receipt not counted: %+v", got)
	}
	if err := os.Remove(filepath.Join(dir, "receipts/message.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "receipts")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "receipts"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if got := c.Status(); got.Verified || got.Error == "" {
		t.Fatalf("unreadable receipt state counted as idle: %+v", got)
	}
}

type unusedResidentTransport struct{ opened bool }

func (t *unusedResidentTransport) OpenDaemon(context.Context, string) (residency.DaemonStream, error) {
	t.opened = true
	return nil, errors.New("unexpected stream")
}
func (t *unusedResidentTransport) Wrap(_ string, direct http.RoundTripper) http.RoundTripper {
	return direct
}

func TestExpiredResidentExecutionCannotOpenTransportOrLaunch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, key := range []string{"CDX_CONFIG_PATH", "CLX_CONFIG_PATH", "CGX_CONFIG_PATH"} {
		t.Setenv(key, filepath.Join(home, key+"-missing"))
	}
	dir, err := daemonStateDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "deadline.json"), []byte(`"2000-01-01T00:00:00Z"`), 0600); err != nil {
		t.Fatal(err)
	}
	c := NewResidentController("test", io.Discard, io.Discard)
	transport := &unusedResidentTransport{}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Run(ctx, transport); err != nil {
		t.Fatal(err)
	}
	if transport.opened {
		t.Fatal("expired execution opened daemon channel")
	}
	if got := c.Status(); got.Running || !got.Verified || !got.Workload.Quiet() {
		t.Fatalf("expired controller did not drain: %+v", got)
	}
}

type callbackDaemonStream struct{ send func(any) error }

func (s callbackDaemonStream) Send(v any) error  { return s.send(v) }
func (s callbackDaemonStream) Receive(any) error { return io.EOF }
func (s callbackDaemonStream) Close() error      { return nil }

func TestInjectedDaemonStreamKeepsClaimEnvelopeAndRejectionSemantics(t *testing.T) {
	for _, reject := range []bool{false, true} {
		t.Run(map[bool]string{false: "accepted", true: "rejected"}[reject], func(t *testing.T) {
			c := &daemonConnection{pending: map[string]chan daemonFrame{}, done: make(chan struct{})}
			c.ws = callbackDaemonStream{send: func(v any) error {
				frame := v.(map[string]any)
				if frame["type"] != "accept" {
					t.Fatalf("wrong method: %+v", frame)
				}
				payload := frame["payload"].(map[string]any)
				if payload["claim_id"] != "original-claim" || payload["operation_id"] != "original-operation" {
					t.Fatalf("claim changed: %+v", payload)
				}
				result := daemonFrame{ID: frame["id"].(string), Result: json.RawMessage(`{"accepted":true}`)}
				if reject {
					result.Error = "daemon_busy"
				}
				c.mu.Lock()
				ch := c.pending[result.ID]
				c.mu.Unlock()
				ch <- result
				return nil
			}}
			var result struct{ Accepted bool }
			err := c.rpc(context.Background(), "accept", map[string]any{"claim_id": "original-claim", "operation_id": "original-operation"}, &result)
			if reject {
				var rejection *daemonRejection
				if !errors.As(err, &rejection) {
					t.Fatalf("rejection became ambiguous: %v", err)
				}
			} else if err != nil || !result.Accepted {
				t.Fatalf("accept failed: %+v %v", result, err)
			}
		})
	}
}

func TestResidentStatusIOCannotDelayAdmissionFenceOrVerifyReboundSnapshot(t *testing.T) {
	c := NewResidentController("test", io.Discard, io.Discard)
	c.started = true
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	c.bindSnapshot(func() (residency.Workload, error) {
		close(entered)
		<-release
		return residency.Workload{Receipts: 2}, nil
	})
	result := make(chan residency.ExecutionStatus, 1)
	go func() { result <- c.Status() }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("snapshot did not start")
	}
	progressed := make(chan error, 1)
	go func() {
		finish, ok := c.permit()
		if !ok {
			progressed <- errors.New("unfenced admission refused")
			return
		}
		c.Fence()
		if _, ok := c.permit(); ok {
			progressed <- errors.New("fenced admission allowed")
			return
		}
		finish()
		c.bindSnapshot(func() (residency.Workload, error) { return residency.Workload{Receipts: 4}, nil })
		progressed <- nil
	}()
	select {
	case err := <-progressed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("receipt I/O blocked admission, fencing or snapshot rebind")
	}
	unblock()
	select {
	case status := <-result:
		if status.Verified || !status.Fenced || status.Workload.PeerClaims != 0 {
			t.Fatalf("stale sample trusted: %+v", status)
		}
	case <-time.After(time.Second):
		t.Fatal("snapshot did not return")
	}
	if status := c.Status(); !status.Verified || status.Workload.Receipts != 4 || !status.Fenced {
		t.Fatalf("fresh snapshot missing: %+v", status)
	}
}

func TestResidentStatusCannotProveIdleWhenAPermitFinishesAfterReceiptRead(t *testing.T) {
	c := NewResidentController("test", io.Discard, io.Discard)
	c.started = true
	finish, ok := c.permit()
	if !ok {
		t.Fatal("initial permit refused")
	}
	c.Fence()
	entered, release := make(chan struct{}), make(chan struct{})
	var signal, unblockOnce sync.Once
	unblock := func() { unblockOnce.Do(func() { close(release) }) }
	defer unblock()
	var receipts atomic.Int32
	c.bindSnapshot(func() (residency.Workload, error) {
		observed := int(receipts.Load())
		signal.Do(func() { close(entered) })
		<-release
		return residency.Workload{Receipts: observed}, nil
	})
	result := make(chan residency.ExecutionStatus, 1)
	go func() { result <- c.Status() }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("snapshot did not start")
	}
	completed := make(chan struct{})
	go func() { receipts.Store(1); finish(); close(completed) }()
	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("I/O prevented accepted work from finishing")
	}
	unblock()
	select {
	case status := <-result:
		if status.Verified || status.Workload.Quiet() {
			t.Fatalf("receipt-producing completion was declared idle: %+v", status)
		}
	case <-time.After(time.Second):
		t.Fatal("status did not finish")
	}
	if status := c.Status(); !status.Verified || status.Workload.Receipts != 1 || status.Workload.Quiet() {
		t.Fatalf("stable receipt snapshot lost: %+v", status)
	}
}
