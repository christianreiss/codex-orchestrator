// Package projectfiles uploads durable CoCo artifacts directly from disk.
package projectfiles

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

const usage = "cxx project file put SLUG FILE [--stored-name NAME] [--description TEXT] [--mime-type TYPE] [--engine codex|claude|grok|kimi] [--json]\nReplaces the project file with the same stored name. Maximum decoded size: 4 MiB."
const maxBytes = 4 << 20

type options struct {
	slug, path, name, description, mime, engine string
	json                                        bool
}

func parse(args []string, engine string) (options, error) {
	o := options{engine: engine}
	if len(args) < 4 || args[0] != "file" || args[1] != "put" {
		return o, fmt.Errorf("%s", usage)
	}
	o.slug, o.path = args[2], args[3]
	o.name = filepath.Base(o.path)
	for i := 4; i < len(args); i++ {
		flag := args[i]
		if flag == "--json" {
			o.json = true
			continue
		}
		switch flag {
		case "--stored-name", "--description", "--mime-type", "--engine":
		default:
			return o, fmt.Errorf("unexpected project argument %q", flag)
		}
		i++
		if i >= len(args) {
			return o, fmt.Errorf("%s requires a value", flag)
		}
		switch flag {
		case "--stored-name":
			o.name = args[i]
		case "--description":
			o.description = args[i]
		case "--mime-type":
			o.mime = args[i]
		case "--engine":
			o.engine = args[i]
		}
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

// Result deliberately excludes the uploaded content: metadata is all a caller needs.
type Result struct {
	Project string `json:"project"`
	File    struct {
		ID     int64  `json:"id"`
		Name   string `json:"stored_name"`
		Size   int64  `json:"size_bytes"`
		SHA256 string `json:"content_sha256"`
	} `json:"file"`
}

func put(ctx context.Context, httpClient *http.Client, base, key string, o options) (Result, error) {
	var out Result
	file, err := os.Open(o.path)
	if err != nil {
		return out, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return out, err
	}
	if !info.Mode().IsRegular() {
		return out, fmt.Errorf("project file must be a regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return out, err
	}
	if len(raw) > maxBytes {
		return out, fmt.Errorf("project files cap at 4 MiB decoded")
	}
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	args := map[string]any{"slug": o.slug, "stored_name": o.name, "content": base64.StdEncoding.EncodeToString(raw), "encoding": "base64", "description": o.description}
	if o.mime != "" {
		args["mime_type"] = o.mime
	}
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "project-file-put", "method": "tools/call", "params": map[string]any{"name": "project_file_upsert", "arguments": args}})
	if err != nil {
		return out, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+"/mcp", bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	req.Header.Set("X-API-Key", key)
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("X-Engine", o.engine)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	communicator.SetAPIHeader(req.Header)
	// One request only. An uncertain mutation is reconciled by inspecting project_files;
	// it never authorizes an automatic second overwrite after another writer.
	resp, err := httpClient.Do(req)
	if err != nil {
		return out, fmt.Errorf("project upload outcome unconfirmed; inspect project_files before retrying: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("project upload HTTP %d; inspect project_files before retrying", resp.StatusCode)
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
	if err = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&reply); err != nil {
		return out, fmt.Errorf("project upload receipt incomplete; inspect project_files before retrying: %w", err)
	}
	if reply.ID != "project-file-put" {
		return out, fmt.Errorf("project upload receipt ID mismatch")
	}
	if reply.Error != nil {
		return out, fmt.Errorf("project upload rejected: %s", reply.Error.Message)
	}
	if reply.Result.IsError {
		return out, fmt.Errorf("project upload rejected; inspect project state and server diagnostic")
	}
	for _, content := range reply.Result.Content {
		if content.Type == "text" && json.Unmarshal([]byte(content.Text), &out) == nil && out.File.SHA256 != "" {
			break
		}
	}
	if out.Project != o.slug || out.File.Name != o.name || out.File.SHA256 != digest || out.File.Size != int64(len(raw)) {
		return out, fmt.Errorf("project upload receipt does not match local name, size or SHA-256; inspect project_files before retrying")
	}
	return out, nil
}
func Command(args []string, engine string, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Fprintln(stdout, usage)
		return 0
	}
	o, err := parse(args, engine)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
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
		fmt.Fprintln(stderr, "project: engine is suspended")
		return 1
	}
	client, err := update.HTTPClient(cfg)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	client.Timeout = 120 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	result, err := put(ctx, client, cfg.Orchestrator.BaseURL, cfg.Orchestrator.APIKey, o)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if o.json {
		err = json.NewEncoder(stdout).Encode(result)
	} else {
		_, err = fmt.Fprintf(stdout, "%s/%s  %d bytes  SHA-256 %s\n", result.Project, result.File.Name, result.File.Size, result.File.SHA256)
	}
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}
