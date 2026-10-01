package agentbus

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"
)

const grokFrameLimit = 8 << 20

// Grok's private leader speaks length-prefixed ACP, not JSONL or WebSockets.
// Stdio registration keeps the relay disabled and leaves the TUI as driver.
type grokQueue struct {
	mu       sync.Mutex
	conn     net.Conn
	sequence int
	thread   string
}

func openGrokQueue(ctx context.Context, socket, thread string) (*grokQueue, error) {
	if socket == "" {
		return nil, errors.New("Grok automatic reception requires the managed private leader")
	}
	conn, err := (&net.Dialer{Timeout: 8 * time.Second}).DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, err
	}
	q := &grokQueue{conn: conn, thread: thread}
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
	if err = q.write(map[string]any{"type": "register", "client_type": "cxx-receiver", "mode": "stdio", "capabilities": map[string]any{}}); err != nil {
		q.close()
		return nil, err
	}
	registered := false
	for {
		frame, err := q.read()
		if err != nil {
			q.close()
			return nil, err
		}
		switch stringArg(frame, "type") {
		case "registered":
			registered = true
			if ready, present := frame["ready"].(bool); !present || ready {
				return q, nil
			}
		case "leader_ready":
			if registered {
				return q, nil
			}
		case "error", "shutdown":
			q.close()
			return nil, errors.New("Grok private leader registration failed")
		}
	}
}

func (q *grokQueue) close() { _ = q.conn.Close() }
func (q *grokQueue) write(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > grokFrameLimit {
		return errors.New("Grok IPC frame too large")
	}
	frame := make([]byte, 4+len(data))
	binary.BigEndian.PutUint32(frame, uint32(len(data)))
	copy(frame[4:], data)
	for len(frame) > 0 {
		n, err := q.conn.Write(frame)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		frame = frame[n:]
	}
	return nil
}
func (q *grokQueue) read() (map[string]any, error) {
	var header [4]byte
	if _, err := io.ReadFull(q.conn, header[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > grokFrameLimit {
		return nil, errors.New("invalid Grok IPC frame length")
	}
	data := make([]byte, int(n))
	if _, err := io.ReadFull(q.conn, data); err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, errors.New("invalid Grok IPC JSON")
	}
	return out, nil
}
func (q *grokQueue) sendRPC(method string, params any) (string, error) {
	q.sequence++
	id := fmt.Sprintf("cxx:%d", q.sequence)
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		return "", err
	}
	return id, q.write(map[string]any{"type": "acp", "payload": string(payload)})
}
func (q *grokQueue) readACP() (map[string]any, error) {
	for {
		frame, err := q.read()
		if err != nil {
			return nil, err
		}
		switch stringArg(frame, "type") {
		case "shutdown", "error":
			return nil, errors.New("Grok private leader disconnected")
		case "acp":
			var out map[string]any
			if json.Unmarshal([]byte(stringArg(frame, "payload")), &out) != nil {
				return nil, errors.New("invalid Grok ACP payload")
			}
			return out, nil
		}
	}
}
func (q *grokQueue) call(method string, params any, out any) error {
	_ = q.conn.SetDeadline(time.Now().Add(8 * time.Second))
	id, err := q.sendRPC(method, params)
	if err != nil {
		return err
	}
	for {
		response, err := q.readACP()
		if err != nil {
			return err
		}
		// Reverse requests belong to the native TUI. Never answer approvals.
		if stringArg(response, "method") != "" || stringArg(response, "id") != id {
			continue
		}
		if detail, ok := response["error"].(map[string]any); ok {
			return fmt.Errorf("Grok ACP %s failed (code %v)", method, detail["code"])
		}
		raw, err := json.Marshal(response["result"])
		if err != nil {
			return err
		}
		return json.Unmarshal(raw, out)
	}
}

type grokRoster struct {
	Sessions []struct {
		ID       string `json:"sessionId"`
		Kind     string `json:"sessionKind"`
		Resident bool   `json:"resident"`
		Activity string `json:"activity"`
	} `json:"sessions"`
}

func (q *grokQueue) roster() (grokRoster, error) {
	// ACP extension replies wrap their payload in a second `result` object.
	// Native builds that returned the earlier direct shape remain supported.
	var wire struct {
		grokRoster
		Result *grokRoster `json:"result"`
	}
	err := q.call("_x.ai/sessions/list", map[string]any{}, &wire)
	if wire.Result != nil {
		return *wire.Result, err
	}
	return wire.grokRoster, err
}
func (q *grokQueue) identity() (string, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	list, err := q.roster()
	if err != nil {
		return "", err
	}
	var roots []string
	for _, s := range list.Sessions {
		if !s.Resident || s.Kind != "" || s.Activity == "dead" || s.Activity == "completed" {
			continue
		}
		if q.thread != "" && s.ID == q.thread {
			return q.thread, nil
		}
		roots = append(roots, s.ID)
	}
	if q.thread != "" {
		return "", errors.New("bound Grok native session is not resident")
	}
	if len(roots) != 1 {
		return "", fmt.Errorf("Grok native identity is not unique (%d resident roots)", len(roots))
	}
	q.thread = roots[0]
	return q.thread, nil
}
func (q *grokQueue) status() (string, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	list, err := q.roster()
	if err != nil {
		return "", err
	}
	for _, s := range list.Sessions {
		if s.ID == q.thread && s.Resident {
			return s.Activity, nil
		}
	}
	return "", errors.New("bound Grok native session unloaded")
}
func grokAdmission(event map[string]any, session, prompt string) bool {
	method := strings.TrimPrefix(stringArg(event, "method"), "_")
	params, _ := event["params"].(map[string]any)
	if stringArg(params, "sessionId") != session {
		return false
	}
	meta, _ := params["_meta"].(map[string]any)
	if replay, _ := meta["replay"].(bool); replay {
		return false
	}
	if method == "x.ai/queue/changed" {
		if stringArg(params, "runningPromptId") == prompt {
			return true
		}
		entries, _ := params["entries"].([]any)
		for _, entry := range entries {
			if e, ok := entry.(map[string]any); ok && stringArg(e, "id") == prompt {
				return true
			}
		}
	}
	return method == "session/update" && stringArg(meta, "promptId") == prompt
}
func (q *grokQueue) send(id, content string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.thread == "" {
		return errors.New("Grok native session identity missing")
	}
	_ = q.conn.SetDeadline(time.Now().Add(8 * time.Second))
	rpcID, err := q.sendRPC("session/prompt", map[string]any{"sessionId": q.thread, "prompt": []any{map[string]any{"type": "text", "text": content}}, "_meta": map[string]any{"promptId": id, "sendNow": false}})
	if err != nil {
		return err
	}
	for {
		event, err := q.readACP()
		if err != nil {
			return fmt.Errorf("Grok prompt admission uncertain: %w", err)
		}
		if grokAdmission(event, q.thread, id) {
			return nil
		}
		if stringArg(event, "id") == rpcID && event["error"] != nil {
			return errors.New("Grok prompt rejected before admission")
		}
		// PromptResponse closes the model turn, not the admission handshake.
		// Its success never fabricates agent_reply or portal completion.
	}
}
