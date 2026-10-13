package communicator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"github.com/google/uuid"
)

var executableDigestOnce sync.Once
var executableDigest string

// Native clients import this package too. Hash only an actual runtime owner's
// first diagnostic response, rather than reading the binary on every launch.
func processExecutableDigest() string {
	executableDigestOnce.Do(func() {
		path, err := os.Executable()
		if err != nil {
			return
		}
		if runtime.GOOS == "linux" {
			path = "/proc/self/exe"
		}
		executableDigest, _ = residency.DigestFile(path)
	})
	return executableDigest
}

// Management is run as the configured service user. Namespace discovery still
// verifies private files and the kernel peer; root callers receive identity data,
// never permission to target an arbitrary PID.
func residentManagement(ctx context.Context, args []string, out io.Writer) error {
	if len(args) != 2 && len(args) != 4 {
		return errors.New("usage: communicator migration inspect CONFIG | prepare|commit CONFIG REQUEST_ID OWNER_INSTANCE_ID")
	}
	command, path := args[0], args[1]
	if command != "inspect" && command != "prepare" && command != "commit" {
		return errors.New("invalid migration command")
	}
	if command != "inspect" && len(args) != 4 {
		return errors.New("missing migration identity")
	}
	key, err := signing.PublicKey()
	if err != nil {
		return err
	}
	cfg, err := loadSigned(path, key)
	if err != nil {
		return err
	}
	socket, err := discoverResidentOwner(ctx, cfg.Orchestrator.BaseURL)
	if err != nil {
		return err
	}
	if socket == "" {
		return errors.New("no compatible runtime owner")
	}
	record, err := readResidentOwner(cfg.Orchestrator.BaseURL)
	if err != nil {
		return err
	}
	client := unixClient(socket, 2*time.Second)
	requestPath := "/_comm/status"
	method := http.MethodGet
	var body io.Reader
	if command != "inspect" {
		if _, err := uuid.Parse(args[2]); err != nil {
			return err
		}
		if args[3] != record.Instance {
			return errors.New("migration owner identity changed")
		}
		raw, _ := json.Marshal(map[string]string{"command": command, "request_id": args[2], "owner_instance_id": args[3]})
		body = bytes.NewReader(raw)
		requestPath = "/_comm/handoff"
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://communicator.local"+requestPath, body)
	if err != nil {
		return err
	}
	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("migration owner HTTP %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil {
		return err
	}
	if len(raw) > 65536 {
		return errors.New("migration owner response too large")
	}
	var view map[string]any
	if err := json.Unmarshal(raw, &view); err != nil {
		return err
	}
	if command == "inspect" {
		if view["owner_instance_id"] != record.Instance || view["pid"] != float64(record.PID) || view["runtime_protocol"] != float64(residency.Protocol) {
			return errors.New("migration owner response identity mismatch")
		}
		view["socket"] = socket
		view["namespace"] = record.Namespace
	} else if view["owner_instance_id"] != record.Instance || view["request_id"] != args[2] || view["accepted"] != true {
		return errors.New("migration acknowledgement identity mismatch")
	}
	return json.NewEncoder(out).Encode(view)
}
