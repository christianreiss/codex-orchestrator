package communicator

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

func Command(args []string, in io.Reader, out, stderr io.Writer, version string) int {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer cancel()
	if len(args) == 3 && args[0] == "serve" && args[1] == "--config" {
		if err := serve(ctx, args[2], version); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return 0
	}
	if len(args) == 2 && args[0] == "mcp" {
		Configure(ctx)
		if err := mcp(ctx, args[1], in, out); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return 0
	}
	if len(args) == 0 || args[0] == "status" || args[0] == "doctor" {
		Configure(ctx)
		count := 0
		failed := false
		registry.Range(func(_, v any) bool {
			count++
			ep := v.(*endpoint)
			res, err := unixClient(ep.socket, 2*time.Second).Get("http://communicator.local/_comm/status")
			if err != nil {
				failed = true
				json.NewEncoder(out).Encode(map[string]any{"server": ep.base, "running": false, "socket": ep.socket})
			} else {
				var status map[string]any
				if err := json.NewDecoder(res.Body).Decode(&status); err != nil {
					failed = true
				} else {
					json.NewEncoder(out).Encode(status)
					if status["connected"] != true && status["https_fallback"] != true {
						failed = true
					}
					if scopes, ok := status["sync_scopes"].([]any); ok {
						for _, raw := range scopes {
							scope, _ := raw.(map[string]any)
							auth, _ := scope["auth"].(map[string]any)
							if scope["content_error"] != "" || auth["state"] == "error" {
								failed = true
							}
						}
					}
				}
				res.Body.Close()
			}
			return true
		})
		if count == 0 {
			json.NewEncoder(out).Encode(map[string]any{"enabled": false, "reason": "No signed communicator capability"})
		}
		if failed && len(args) > 0 && args[0] == "doctor" {
			return 1
		}
		return 0
	}
	fmt.Fprintln(stderr, "usage: cxx communicator [status|doctor|mcp ENGINE]")
	return 2
}
func mcp(ctx context.Context, engine string, in io.Reader, out io.Writer) error {
	path, err := config.DefaultPathForEngine(engine)
	if err != nil {
		return err
	}
	key, err := signing.PublicKey()
	if err != nil {
		return err
	}
	cfg, err := config.LoadForEngine(path, key, false, engine)
	if err != nil {
		return err
	}
	bearer := os.Getenv("CXX_MCP_BEARER")
	if bearer == "" {
		return fmt.Errorf("managed MCP credential missing; synchronize engine config")
	}
	direct, err := directTransport(cfg)
	if err != nil {
		return err
	}
	client := &http.Client{Transport: Wrap(direct), Timeout: 120 * time.Second}
	var writes sync.Mutex
	write := func(raw []byte) {
		var value any
		if json.Unmarshal(raw, &value) == nil {
			writes.Lock()
			json.NewEncoder(out).Encode(value)
			writes.Unlock()
		}
	}
	forward := func(raw []byte) (int, []byte, error) {
		req, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(cfg.Orchestrator.BaseURL, "/")+"/mcp", bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+bearer)
		req.Header.Set("X-Engine", engine)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		res, err := client.Do(req)
		if err != nil {
			return 0, nil, err
		}
		body, err := io.ReadAll(io.LimitReader(res.Body, 16*1024*1024))
		res.Body.Close()
		if err == nil && res.StatusCode >= 400 {
			err = fmt.Errorf("CoCo MCP HTTP %d", res.StatusCode)
		}
		return res.StatusCode, body, err
	}
	// The native client may keep stdin open after SIGTERM, so reading must not
	// hold the process: on cancellation stop accepting input, let in-flight
	// requests report their (unknown) outcome, then exit.
	lines := make(chan []byte)
	scanErr := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(in)
		scanner.Buffer(make([]byte, 4096), 8*1024*1024)
		for scanner.Scan() {
			select {
			case lines <- append([]byte(nil), scanner.Bytes()...):
			case <-ctx.Done():
				return
			}
		}
		scanErr <- scanner.Err()
	}()
	var work sync.WaitGroup
	defer work.Wait()
	for {
		var raw []byte
		select {
		case <-ctx.Done():
			return nil
		case err := <-scanErr:
			return err
		case raw = <-lines:
		}
		raw = bytes.TrimSpace(raw)
		if len(raw) == 0 {
			continue
		}
		if !json.Valid(raw) {
			write([]byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`))
			continue
		}
		ids, batch, ok := mcpRequestIDs(raw)
		if !ok {
			write([]byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}`))
			continue
		}
		work.Add(1)
		go func() {
			defer work.Done()
			status, body, err := forward(raw)
			if len(ids) == 0 {
				return
			}
			if !batch {
				if err != nil {
					body = mcpFailure(ids[0], status, body)
				} else if !mcpResponseValid(ids[0], body) {
					body = mcpFailure(ids[0], status, nil)
				}
				write(body)
				return
			}
			if err != nil || !mcpBatchResponseValid(ids, body) {
				if err == nil {
					body = nil
				}
				failures := make([]json.RawMessage, 0, len(ids))
				for _, id := range ids {
					failures = append(failures, mcpFailure(id, status, body))
				}
				body, _ = json.Marshal(failures)
			}
			write(body)
		}()
	}
}

// mcpRequestIDs returns the IDs that expect a reply. A batch (JSON-RPC 2.0,
// MCP 2025-03-26) is forwarded whole; its notifications get no reply, matching
// the API dispatcher, which omits them and answers an all-notification batch
// with 202. ok is false for input that is neither an object nor a non-empty array.
func mcpRequestIDs(raw []byte) (ids []json.RawMessage, batch, ok bool) {
	idOf := func(item json.RawMessage) (json.RawMessage, bool) {
		var request map[string]json.RawMessage
		if json.Unmarshal(item, &request) != nil || request == nil {
			return nil, false
		}
		return request["id"], true
	}
	if raw[0] != '[' {
		id, ok := idOf(raw)
		if !ok {
			return nil, false, false
		}
		if len(id) > 0 {
			ids = append(ids, id)
		}
		return ids, false, true
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil || len(items) == 0 {
		return nil, true, false
	}
	for _, item := range items {
		// Invalid members still go upstream; the server answers each with id null.
		if id, ok := idOf(item); ok && len(id) > 0 && string(id) != "null" {
			ids = append(ids, id)
		}
	}
	return ids, true, true
}

// A batch reply must be an array of valid envelopes answering every request
// exactly once; id null entries are the server's Invalid Request answers.
func mcpBatchResponseValid(ids []json.RawMessage, body []byte) bool {
	var replies []json.RawMessage
	if json.Unmarshal(body, &replies) != nil || len(replies) == 0 {
		return false
	}
	answered := make([]bool, len(ids))
	for _, reply := range replies {
		var envelope struct {
			ID json.RawMessage `json:"id"`
		}
		if json.Unmarshal(reply, &envelope) != nil {
			return false
		}
		if string(envelope.ID) == "null" {
			if !mcpResponseValid(envelope.ID, reply) {
				return false
			}
			continue
		}
		matched := false
		for i, id := range ids {
			if !answered[i] && mcpResponseValid(id, reply) {
				answered[i], matched = true, true
				break
			}
		}
		if !matched {
			return false
		}
	}
	for _, ok := range answered {
		if !ok {
			return false
		}
	}
	return true
}

// Preserve an ambiguous write's meaning at the model-facing boundary. A generic
// tool failure invites a fresh retry even when the server already committed it.
// Forward only a bounded machine code, never an upstream body or credentials.
func mcpFailure(id json.RawMessage, status int, body []byte) []byte {
	var failure struct {
		Code  string `json:"code"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &failure)
	code := failure.Code
	if code == "" {
		code = failure.Error.Code
	}
	if len(code) > 128 || strings.IndexFunc(code, func(r rune) bool {
		return r != '_' && r != '-' && r != '.' && (r < 'a' || r > 'z') && (r < '0' || r > '9')
	}) >= 0 {
		code = ""
	}
	if status < 400 {
		code = "communicator_outcome_unknown"
	} else if code == "" {
		code = "communicator_request_failed"
	}
	message := "CoCo communicator unavailable or request rejected"
	// The dispatcher applies this limit after the route has returned. Its
	// effects may already be committed even though no usable reply fits.
	unknown := code == "communicator_outcome_unknown" || code == "communicator_response_too_large"
	if unknown {
		message = "Request outcome unknown; it may already have completed. Verify its result before retrying and retain the original idempotency or claim identifiers."
	}
	raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{
		"code": -32000, "message": message,
		"data": map[string]any{"code": code, "http_status": status, "outcome_unknown": unknown},
	}})
	return raw
}

// A response carries exactly one of result (any value, including null) or an
// error object with an integer code and a string message.
func mcpResponseValid(id json.RawMessage, body []byte) bool {
	var response map[string]json.RawMessage
	if json.Unmarshal(body, &response) != nil || string(response["jsonrpc"]) != `"2.0"` || !sameMCPID(response["id"], id) {
		return false
	}
	result, hasResult := response["result"]
	rawError, hasError := response["error"]
	if hasResult == hasError || hasResult && len(result) == 0 {
		return false
	}
	if hasError {
		var failure map[string]json.RawMessage
		if json.Unmarshal(rawError, &failure) != nil || failure == nil {
			return false
		}
		// int64 rejects 1.0 and 1e3 as well as strings and null.
		var code int64
		var message string
		if json.Unmarshal(failure["code"], &code) != nil || json.Unmarshal(failure["message"], &message) != nil {
			return false
		}
	}
	return true
}

func sameMCPID(a, b json.RawMessage) bool {
	decode := func(raw json.RawMessage) (any, error) {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var value any
		err := decoder.Decode(&value)
		return value, err
	}
	left, err := decode(a)
	if err != nil {
		return false
	}
	right, err := decode(b)
	if err != nil {
		return false
	}
	switch value := left.(type) {
	case string:
		other, ok := right.(string)
		return ok && value == other
	case json.Number:
		other, ok := right.(json.Number)
		if !ok {
			return false
		}
		x, validX := canonicalRPCNumber(value.String())
		y, validY := canonicalRPCNumber(other.String())
		return validX && validY && x == y
	case nil:
		return right == nil
	}
	return false
}

// Compare decimal values exactly: float64 would collapse distinct large IDs.
// Normalization is linear in the bounded JSON input and never expands an exponent.
func canonicalRPCNumber(raw string) (string, bool) {
	mantissa, exponent := raw, "0"
	if i := strings.IndexAny(raw, "eE"); i >= 0 {
		mantissa, exponent = raw[:i], raw[i+1:]
	}
	negative := strings.HasPrefix(mantissa, "-")
	mantissa = strings.TrimPrefix(mantissa, "-")
	var offset int64
	if i := strings.IndexByte(mantissa, '.'); i >= 0 {
		offset = -int64(len(mantissa) - i - 1)
		mantissa = mantissa[:i] + mantissa[i+1:]
	}
	mantissa = strings.TrimLeft(mantissa, "0")
	if mantissa == "" {
		return "0", true
	}
	digits := strings.TrimRight(mantissa, "0")
	offset += int64(len(mantissa) - len(digits))
	exp, err := strconv.ParseInt(exponent, 10, 64)
	const maxInt64 = int64((1 << 63) - 1)
	const minInt64 = -maxInt64 - 1
	if err != nil || offset > 0 && exp > maxInt64-offset || offset < 0 && exp < minInt64-offset {
		return "", false
	}
	if negative {
		digits = "-" + digits
	}
	return digits + "e" + strconv.FormatInt(exp+offset, 10), true
}
