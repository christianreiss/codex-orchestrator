package agentbus

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"time"
)

// Feedback 43fe5d65: the Stop hook blocked turn end for mail the automatic
// receiver delivers itself, for informational classes that need no answer, and
// once per distinct queued message, so a conference cost one empty turn per peer.

func stopBlocks(t *testing.T, box *mailbox, end *turnEnd) bool {
	t.Helper()
	var out bytes.Buffer
	if err := emitHook(&out, hookEventStop, box, end); err != nil {
		t.Fatal(err)
	}
	return strings.Contains(out.String(), `"decision":"block"`)
}

func TestStopHookRingPolicy(t *testing.T) {
	peer := mailboxPeer{Alias: "Thekla"}
	read := []heldDelivery{{MessageID: "read-1", Kind: "informational"}}
	cases := []struct {
		name  string
		entry mailboxEntry
		end   *turnEnd
		want  bool
	}{
		// (a) deliveries the automatic receiver delivers itself
		{"ready receiver, nothing read held, turn-gated", mailboxEntry{MessageID: "m", Kind: "request"}, &turnEnd{receiverReady: true, afterTurn: true}, false},
		{"ready receiver, nothing read held, no turn gating", mailboxEntry{MessageID: "m", Kind: "request"}, &turnEnd{receiverReady: true}, false},
		{"ready receiver just released the read delivery", mailboxEntry{MessageID: "m", Kind: "request"}, &turnEnd{receiverReady: true, released: 1}, false},
		// not automatic / not ready: the ring is the only notification
		{"no owner information", mailboxEntry{MessageID: "m", Kind: "request"}, nil, true},
		{"receiver not ready", mailboxEntry{MessageID: "m", Kind: "request"}, &turnEnd{afterTurn: true}, true},
		// a read delivery that could not be released keeps reception shut
		{"read delivery still held", mailboxEntry{MessageID: "m", Kind: "request"}, &turnEnd{receiverReady: true, afterTurn: true, stillHeld: read}, true},
		// held work/Portal pause reception; that ring survives
		{"read work held", mailboxEntry{MessageID: "m", Kind: "request"}, &turnEnd{receiverReady: true, blocked: true, stillHeld: []heldDelivery{{MessageID: "w", Kind: "work"}}}, true},
		// (c) informational classes never block, even with no receiver at all
		{"presence notice, no owner", mailboxEntry{MessageID: "m", Kind: "presence_notice"}, nil, false},
		{"publication, no owner", mailboxEntry{MessageID: "m", Kind: "publication"}, nil, false},
		{"digest, no owner", mailboxEntry{MessageID: "m", Kind: "digest"}, nil, false},
		{"notice class, no owner", mailboxEntry{MessageID: "m", Kind: "message", DeliveryClass: "notice"}, nil, false},
		{"progress class, no owner", mailboxEntry{MessageID: "m", Kind: "reply", DeliveryClass: "progress"}, nil, false},
		// genuine unread mail that needs an answer still rings
		{"information message, no owner", mailboxEntry{MessageID: "m", Kind: "message", DeliveryClass: "information"}, nil, true},
		{"coordination message, no owner", mailboxEntry{MessageID: "m", Kind: "message", DeliveryClass: "coordination"}, nil, true},
		{"old server without class, no owner", mailboxEntry{MessageID: "m", Kind: "request"}, nil, true},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv(envSessionID, fmt.Sprintf("%08d-0000-4000-8000-000000000000", i+1))
			tc.entry.From = peer
			if got := stopBlocks(t, &mailbox{Pending: []mailboxEntry{tc.entry}}, tc.end); got != tc.want {
				t.Fatalf("Stop blocks = %v, want %v", got, tc.want)
			}
		})
	}
}

// An informational entry must not consume the ring ledger either: it is dropped
// before marking, so a later answerable message still rings.
func TestStopHookIgnoresInformationalBesideAnswerable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "abcdabcd-0000-4000-8000-000000000000")
	box := &mailbox{Pending: []mailboxEntry{
		{MessageID: "n", Kind: "presence_notice", From: mailboxPeer{Alias: "Irmtrud"}},
		{MessageID: "r", Kind: "request", From: mailboxPeer{Alias: "Thekla"}},
	}}
	var out bytes.Buffer
	if err := emitHook(&out, hookEventStop, box, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "1 message waiting") || strings.Contains(out.String(), "Irmtrud") {
		t.Fatalf("only the request may ring: %s", out.String())
	}
}

// A run of distinct messages each rings once, so without a chain cap a
// conference blocks one turn end per peer.
func TestStopHookChainIsCapped(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "cafecafe-0000-4000-8000-000000000000")
	var blocks int
	for i := 0; i < maxStopChain+4; i++ {
		box := &mailbox{Pending: []mailboxEntry{{MessageID: fmt.Sprintf("m-%d", i), Kind: "request", From: mailboxPeer{Alias: "Thekla"}}}}
		if stopBlocks(t, box, nil) {
			blocks++
		}
	}
	if blocks != maxStopChain {
		t.Fatalf("blocked %d times, want exactly the cap %d", blocks, maxStopChain)
	}
	// The suppressed Stops were not recorded, so the prompt ring still announces them.
	box := &mailbox{Pending: []mailboxEntry{{MessageID: fmt.Sprintf("m-%d", maxStopChain+1), Kind: "request"}}}
	if fresh, _ := unrung(hookEventPrompt, box); len(fresh) != 1 {
		t.Fatalf("a capped Stop must leave the prompt ring intact, fresh=%d", len(fresh))
	}
}

func TestStopChainWindowExpires(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(envSessionID, "beefbeef-0000-4000-8000-000000000000")
	ledger := loadRingLedger()
	old := time.Now().Add(-stopChainWindow - time.Minute)
	for i := 0; i < maxStopChain; i++ {
		ledger.mark(fmt.Sprintf("%s%d %d", stopBlockKey, old.Unix(), i))
	}
	if ledger.stopChainFull(time.Now()) {
		t.Fatal("blocks older than the window must not count")
	}
	if !ledger.stopChainFull(old.Add(time.Second)) {
		t.Fatal("blocks inside the window must count")
	}
}
