// Package secretstore saves a fleet credential from a local file or stdin, so
// the value never appears in an agent's tool arguments, transcript or output.
package secretstore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

const usage = "cxx secret store SLUG (--file PATH | --stdin) [--name NAME] [--description TEXT] [--tag TAG]... [--engine codex|claude|grok|kimi] [--json]\n" +
	"Creates SLUG in the fleet secret store, or rotates it when this host owns it, through MCP secret_store.\n" +
	"The value is sent byte for byte, including a trailing newline (pipe with printf '%s', not echo).\n" +
	"It must be valid UTF-8 (base64-encode binary keys) and at most 1 MiB. Omitted fields keep their stored values.\n" +
	"Output names the slug, the status and the byte count; it never prints the value or a digest of it."

// A credential, not an artifact: larger payloads belong in project files or transfers.
const maxBytes = 1 << 20

// retrySafe is appended to every failure after a request may have been sent.
// secret_store is idempotent for one host: storing the same value again
// reports "unchanged", so repeating the command cannot double-apply anything.
const retrySafe = "running the same command again is safe (an identical value reports unchanged)"

type options struct {
	slug, file, name, description, engine string
	stdin, json                           bool
	tags                                  []string
}

func parse(args []string, engine string) (options, error) {
	o := options{engine: engine}
	if len(args) < 2 || args[0] != "store" || args[1] == "" || strings.HasPrefix(args[1], "-") {
		return o, fmt.Errorf("%s", usage)
	}
	o.slug = args[1]
	for i := 2; i < len(args); i++ {
		flag := args[i]
		switch flag {
		case "--json":
			o.json = true
			continue
		case "--stdin":
			o.stdin = true
			continue
		case "--file", "--name", "--description", "--tag", "--engine":
		default:
			return o, fmt.Errorf("unexpected secret argument %q\n%s", flag, usage)
		}
		i++
		if i >= len(args) {
			return o, fmt.Errorf("%s requires a value", flag)
		}
		switch flag {
		case "--file":
			o.file = args[i]
		case "--name":
			o.name = args[i]
		case "--description":
			o.description = args[i]
		case "--tag":
			o.tags = append(o.tags, args[i])
		case "--engine":
			o.engine = args[i]
		}
	}
	if (o.file == "") == !o.stdin {
		return o, fmt.Errorf("secret store needs exactly one of --file PATH or --stdin")
	}
	if o.engine == "" {
		o.engine = os.Getenv("CXX_AGENT_PORTAL_ENGINE")
	}
	if o.engine == "" {
		o.engine = "codex"
	}
	if o.engine != "codex" && o.engine != "claude" && o.engine != "grok" && o.engine != "kimi" {
		return o, fmt.Errorf("engine must be codex, claude, grok or kimi")
	}
	return o, nil
}

// readValue reads the secret before any network use. Errors never quote it.
func readValue(o options, stdin io.Reader) ([]byte, error) {
	source := stdin
	if !o.stdin {
		file, err := os.Open(o.file)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("--file must name a regular file; use --stdin for a pipe")
		}
		source = file
	}
	raw, err := io.ReadAll(io.LimitReader(source, maxBytes+1))
	if err != nil {
		return nil, err
	}
	switch {
	case len(raw) == 0:
		return nil, fmt.Errorf("secret value is empty; nothing was stored")
	case len(raw) > maxBytes:
		return nil, fmt.Errorf("secret values cap at 1 MiB; nothing was stored")
	case !utf8.Valid(raw):
		// JSON would silently replace invalid bytes with U+FFFD and store a
		// corrupted key that still reports "created".
		return nil, fmt.Errorf("secret value is not valid UTF-8; base64-encode binary material first (for example base64 -w0 key.der | cxx secret store SLUG --stdin); nothing was stored")
	}
	return raw, nil
}

// Result is the receipt: metadata only, never the value.
type Result struct {
	Slug       string `json:"slug"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	ValueBytes int    `json:"value_bytes"`
	OwnedByYou bool   `json:"owned_by_you"`
}

func store(ctx context.Context, httpClient *http.Client, base, key string, o options, value []byte) (Result, error) {
	out := Result{ValueBytes: len(value)}
	args := map[string]any{"slug": o.slug, "value": string(value)}
	if o.name != "" {
		args["name"] = o.name
	}
	if o.description != "" {
		args["description"] = o.description
	}
	if len(o.tags) > 0 {
		args["tags"] = o.tags
	}
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "secret-store", "method": "tools/call", "params": map[string]any{"name": "secret_store", "arguments": args}})
	if err != nil {
		return out, errors.New("secret store request could not be encoded; nothing was sent")
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+"/mcp", bytes.NewReader(body))
	if err != nil {
		return out, fmt.Errorf("secret store request could not be built; nothing was sent: %w", err)
	}
	req.Header.Set("X-API-Key", key)
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("X-Engine", o.engine)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	communicator.SetAPIHeader(req.Header)
	resp, err := httpClient.Do(req)
	if err != nil {
		// A *url.Error names the method and URL, never the request body.
		return out, fmt.Errorf("secret store outcome unconfirmed (%s); %s", redact(err.Error(), value), retrySafe)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("secret store HTTP %d; %s", resp.StatusCode, retrySafe)
	}
	var reply struct {
		ID    string `json:"id"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&reply); err != nil {
		return out, fmt.Errorf("secret store receipt incomplete; %s", retrySafe)
	}
	if reply.ID != "secret-store" {
		return out, fmt.Errorf("secret store receipt ID mismatch; %s", retrySafe)
	}
	if reply.Error != nil {
		return out, fmt.Errorf("secret store rejected: %s", redact(reply.Error.Message, value))
	}
	text := ""
	for _, content := range reply.Result.Content {
		if content.Type == "text" {
			text = content.Text
			break
		}
	}
	if reply.Result.IsError {
		return out, fmt.Errorf("secret store rejected: %s", redact(toolError(text), value))
	}
	var receipt struct {
		Secret struct {
			Slug       string `json:"slug"`
			Name       string `json:"name"`
			OwnedByYou bool   `json:"owned_by_you"`
		} `json:"secret"`
		Status string `json:"status"`
	}
	if json.Unmarshal([]byte(text), &receipt) != nil || !strings.EqualFold(receipt.Secret.Slug, strings.TrimSpace(o.slug)) ||
		(receipt.Status != "created" && receipt.Status != "rotated" && receipt.Status != "unchanged") {
		return out, fmt.Errorf("secret store receipt does not name %q with a known status; check secret_list, then %s", o.slug, retrySafe)
	}
	out.Slug, out.Name, out.Status, out.OwnedByYou = receipt.Secret.Slug, receipt.Secret.Name, receipt.Status, receipt.Secret.OwnedByYou
	return out, nil
}

// toolError extracts the server's code and message from an MCP error result.
func toolError(text string) string {
	var wrapped struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(text), &wrapped) == nil && wrapped.Error.Message != "" {
		if wrapped.Error.Code != "" {
			return wrapped.Error.Code + ": " + wrapped.Error.Message
		}
		return wrapped.Error.Message
	}
	if text == "" {
		return "no diagnostic"
	}
	return text
}

// redact bounds a server diagnostic and removes the value should it ever be echoed.
func redact(message string, value []byte) string {
	if len(value) > 0 {
		message = strings.ReplaceAll(message, string(value), "[redacted]")
		if trimmed := strings.TrimSpace(string(value)); len(trimmed) >= 4 {
			message = strings.ReplaceAll(message, trimmed, "[redacted]")
		}
	}
	if runes := []rune(message); len(runes) > 300 {
		message = string(runes[:300]) + "…"
	}
	return message
}

// Command runs `cxx secret ...`. stdin is read only for --stdin.
func Command(args []string, engine string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		if len(args) == 0 {
			io.WriteString(stderr, usage+"\n")
			return 2
		}
		io.WriteString(stdout, usage+"\n")
		return 0
	}
	o, err := parse(args, engine)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	value, err := readValue(o, stdin)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	key, err := signing.PublicKey()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	path, err := config.DefaultPathForEngine(o.engine)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	cfg, _, err := fleetconfig.LoadOrRecover(ctx, path, key, o.engine)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if cfg.EngineSuspended(o.engine) {
		fmt.Fprintln(stderr, "secret: engine is suspended")
		return 1
	}
	client, err := update.HTTPClient(cfg)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	client.Timeout = 60 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	result, err := store(ctx, client, cfg.Orchestrator.BaseURL, cfg.Orchestrator.APIKey, o, value)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if o.json {
		err = json.NewEncoder(stdout).Encode(result)
	} else {
		_, err = fmt.Fprintf(stdout, "%s  %s  %d bytes (value not shown)\n", result.Slug, result.Status, result.ValueBytes)
	}
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}
