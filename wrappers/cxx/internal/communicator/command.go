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
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 4096), 8*1024*1024)
	var writes sync.Mutex
	var work sync.WaitGroup
	for scanner.Scan() {
		raw := append([]byte(nil), scanner.Bytes()...)
		if len(bytes.TrimSpace(raw)) == 0 {
			continue
		}
		var request struct {
			ID json.RawMessage `json:"id"`
		}
		if json.Unmarshal(raw, &request) != nil {
			return fmt.Errorf("invalid MCP JSON")
		}
		work.Add(1)
		go func() {
			defer work.Done()
			req, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(cfg.Orchestrator.BaseURL, "/")+"/mcp", bytes.NewReader(raw))
			req.Header.Set("Authorization", "Bearer "+bearer)
			req.Header.Set("X-Engine", engine)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json")
			res, err := client.Do(req)
			var body []byte
			if err == nil {
				body, err = io.ReadAll(io.LimitReader(res.Body, 16*1024*1024))
				res.Body.Close()
				if res.StatusCode >= 400 {
					err = fmt.Errorf("CoCo MCP HTTP %d", res.StatusCode)
				}
			}
			if len(request.ID) == 0 {
				return
			}
			if err != nil {
				body, _ = json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32000, "message": "CoCo communicator unavailable or request rejected"}})
			}
			if len(body) > 0 {
				var value any
				if json.Unmarshal(body, &value) == nil {
					writes.Lock()
					json.NewEncoder(out).Encode(value)
					writes.Unlock()
				}
			}
		}()
	}
	work.Wait()
	return scanner.Err()
}
