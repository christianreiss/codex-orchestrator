package agentbus

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestReceiverAcknowledgmentIsCheckedByServerBeforeReleasingProbe(t *testing.T) {
	accepted := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/receiver/ack") {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if !accepted {
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"code":"receiver_generation_changed"}`))
			return
		}
		_, _ = w.Write([]byte(`{"receiver":{"state":"ready"}}`))
	}))
	defer server.Close()
	c := &sessionClient{id: "session", http: &http.Client{Transport: rewriteTransport{server: server}}}
	r := &autoReceiver{client: c, generation: "current", pendingProbe: "peer", probeAt: time.Now()}
	args := map[string]any{"generation": "current", "source": "peer", "nonce": "challenge"}
	if _, err := r.ack(context.Background(), args); err == nil {
		t.Fatal("accepted rejected generation")
	}
	if r.pendingProbe != "peer" {
		t.Fatal("rejected acknowledgment released pending probe")
	}
	accepted = true
	if _, err := r.ack(context.Background(), args); err != nil {
		t.Fatal(err)
	}
	if r.pendingProbe != "" {
		t.Fatal("verified probe remained pending")
	}
}

type rewriteTransport struct{ server *httptest.Server }

func (r rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = "http"
	req.URL.Host = strings.TrimPrefix(r.server.URL, "http://")
	return http.DefaultTransport.RoundTrip(req)
}

func TestAutomaticListenDoesNotClaimOrCompleteNativeDeliveries(t *testing.T) {
	c := &sessionClient{}
	tracker := newChannelTracker(c)
	tracker.receiver = &autoReceiver{client: c}
	tracker.items["pending"] = &channelPending{}
	out, err := agentListen(context.Background(), c, tracker, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if out["status"] != "automatic" || len(tracker.items) != 1 {
		t.Fatal("manual listen competed with native receiver")
	}
}

func TestPortalReplyRequiresOwnedMessage(t *testing.T) {
	r := &autoReceiver{pendingPortal: map[string]any{"message_id": "owned"}}
	if _, err := r.reply(context.Background(), map[string]any{"message_id": "another", "content": "reply"}); err == nil {
		t.Fatal("accepted unrelated portal reply")
	}
}

func TestChannelDeliveryPreservesFullContentAndMessageID(t *testing.T) {
	var output strings.Builder
	r := &autoReceiver{output: &mcpWriter{w: &output}}
	text := "Peer input with \"quotes\"\nand a newline"
	if err := r.deliver("delivery", text); err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Method string `json:"method"`
		Params struct {
			Content string            `json:"content"`
			Meta    map[string]string `json:"meta"`
		} `json:"params"`
	}
	if err := json.Unmarshal([]byte(output.String()), &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Method != "notifications/claude/channel" || wire.Params.Content != text || wire.Params.Meta["message_id"] != "delivery" {
		t.Fatal("delivery changed")
	}
}
