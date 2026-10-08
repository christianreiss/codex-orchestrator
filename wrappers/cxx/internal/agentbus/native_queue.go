package agentbus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/websocket"
)

// The app-server Unix listener uses WebSocket frames, not JSONL. Connect
// directly to the protected socket; no additional native model process exists.
type nativeQueue struct {
	mu               sync.Mutex
	conn             *websocket.Conn
	sequence         int
	lastWatchdogTurn string
	thread           string
}

func openNativeQueue(ctx context.Context, socket string) (*nativeQueue, error) {
	raw, err := (&net.Dialer{Timeout: 8 * time.Second}).DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, err
	}
	_ = raw.SetDeadline(time.Now().Add(8 * time.Second))
	cfg, err := websocket.NewConfig("ws://localhost/", "http://localhost/")
	if err != nil {
		raw.Close()
		return nil, err
	}
	conn, err := websocket.NewClient(cfg, raw)
	if err != nil {
		raw.Close()
		return nil, err
	}
	conn.MaxPayloadBytes = 8 << 20
	q := &nativeQueue{conn: conn}
	var initialized map[string]any
	if err = q.call("initialize", map[string]any{"clientInfo": map[string]any{"name": "cxx-receiver", "version": "1"}, "capabilities": map[string]any{"experimentalApi": true}}, &initialized); err != nil {
		q.close()
		return nil, err
	}
	if err = websocket.JSON.Send(conn, map[string]any{"method": "initialized"}); err != nil {
		q.close()
		return nil, err
	}
	return q, nil
}
func (q *nativeQueue) close() { _ = q.conn.Close() }

func (q *nativeQueue) setSessionName(id, name string) error {
	if q.thread == "" || q.thread != id {
		return errors.New("native naming requires the bound thread")
	}
	var out map[string]any
	return q.call("thread/name/set", map[string]any{"threadId": id, "name": name}, &out)
}
func (q *nativeQueue) call(method string, params any, result any) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	_ = q.conn.SetDeadline(time.Now().Add(8 * time.Second))
	q.sequence++
	if err := websocket.JSON.Send(q.conn, map[string]any{"id": q.sequence, "method": method, "params": params}); err != nil {
		return err
	}
	for {
		var response struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := websocket.JSON.Receive(q.conn, &response); err != nil {
			return fmt.Errorf("native %s: %w", method, err)
		}
		// Server requests and notifications belong to the terminal client. This
		// adapter never grants native tool approvals or handles them on its behalf.
		if response.Method != "" || string(response.ID) != strconv.Itoa(q.sequence) {
			continue
		}
		if len(response.Error) > 0 && string(response.Error) != "null" {
			var detail struct {
				Code int `json:"code"`
			}
			_ = json.Unmarshal(response.Error, &detail)
			return fmt.Errorf("native %s failed (code %d)", method, detail.Code)
		}
		return json.Unmarshal(response.Result, result)
	}
}

func (q *nativeQueue) identity() (string, error) {
	var list struct {
		Data []string `json:"data"`
	}
	if err := q.call("thread/loaded/list", map[string]any{}, &list); err != nil {
		return "", err
	}
	var roots []string
	var sources []any
	for _, id := range list.Data {
		var result struct {
			Thread struct {
				ID     string `json:"id"`
				Source any    `json:"source"`
			} `json:"thread"`
		}
		if err := q.call("thread/read", map[string]any{"threadId": id, "includeTurns": false}, &result); err != nil {
			return "", err
		}
		sources = append(sources, result.Thread.Source)
		if source, ok := result.Thread.Source.(string); ok && (source == "cli" || source == "vscode" || source == "unknown") {
			roots = append(roots, id)
		}
	}
	if q.thread != "" {
		for _, id := range roots {
			if id == q.thread {
				return q.thread, nil
			}
		}
		return "", errors.New("bound native thread unloaded")
	}
	if len(roots) != 1 {
		return "", fmt.Errorf("native thread identity is not unique yet (%d loaded, sources %v)", len(list.Data), sources)
	}
	q.thread = roots[0]
	return q.thread, nil
}

func (q *nativeQueue) send(id, content string) error {
	if q.thread == "" {
		return errors.New("native thread identity missing")
	}
	var added struct {
		Submission struct {
			ID       string `json:"id"`
			ClientID string `json:"clientUserMessageId"`
		} `json:"queuedSubmission"`
	}
	if err := q.call("thread/queue/add", map[string]any{"threadId": q.thread, "clientUserMessageId": id, "input": []any{map[string]any{"type": "text", "text": content}}}, &added); err != nil {
		return err
	}
	if added.Submission.ID == "" || added.Submission.ClientID != id {
		return errors.New("native queue admission receipt missing or uncorrelated")
	}
	// The attached native TUI consumes its queue and starts turns at its own
	// safe boundary. Calling queue/start here races that consumer and would make
	// the adapter a second scheduler. Submission is not execution proof.
	return nil
}

// status is the thread's native status type ("idle", "active", ...), so the
// receiver can say why it is not claiming.
func (q *nativeQueue) status() (string, error) {
	var read struct {
		Thread struct {
			Status struct {
				Type string `json:"type"`
			} `json:"status"`
		} `json:"thread"`
	}
	err := q.call("thread/read", map[string]any{"threadId": q.thread, "includeTurns": false}, &read)
	return read.Thread.Status.Type, err
}

func (q *nativeQueue) watchdogFailure() (string, string, error) {
	var read struct {
		Thread struct {
			Turns []struct {
				ID     string          `json:"id"`
				Status string          `json:"status"`
				Error  json.RawMessage `json:"error"`
			} `json:"turns"`
		} `json:"thread"`
	}
	if err := q.call("thread/read", map[string]any{"threadId": q.thread, "includeTurns": true}, &read); err != nil {
		return "", "", err
	}
	if len(read.Thread.Turns) == 0 {
		return "", "", nil
	}
	turn := read.Thread.Turns[len(read.Thread.Turns)-1]
	q.mu.Lock()
	defer q.mu.Unlock()
	if turn.ID == q.lastWatchdogTurn || (turn.Status != "failed" && turn.Status != "interrupted") {
		return "", "", nil
	}
	q.lastWatchdogTurn = turn.ID
	if turn.Status == "interrupted" {
		return "user_stop", "", nil
	}
	text := strings.ToLower(string(turn.Error))
	if strings.Contains(text, "at capacity") || strings.Contains(text, "rate_limit") || strings.Contains(text, "overloaded") || strings.Contains(text, "usage limit") || strings.Contains(text, "quota limit") {
		return "capacity", scheduleRetryAt(string(turn.Error), time.Now()), nil
	}
	if strings.Contains(text, "authentication") || strings.Contains(text, "billing") || strings.Contains(text, "invalid_api_key") {
		return "blocked", "", nil
	}
	return "crash", "", nil
}
