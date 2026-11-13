package codex

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Probe the upstream control protocol through native runtime initialization.
// This loads the bundled GStreamer plugins, but never sends startTransport or
// openDevices: installation must not contact the backend or open a microphone.
func probeVoiceRuntime(ctx context.Context, helper, commit string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, helper)
	for _, env := range os.Environ() {
		key, _, _ := strings.Cut(env, "=")
		if !strings.HasPrefix(key, "GST_") && !strings.HasPrefix(key, "LD_") && !strings.HasPrefix(key, "DYLD_") {
			cmd.Env = append(cmd.Env, env)
		}
	}
	cmd.Env = append(cmd.Env, "GST_PLUGIN_PATH=", "GST_PLUGIN_PATH_1_0=", "GST_PLUGIN_SYSTEM_PATH=", "GST_PLUGIN_SYSTEM_PATH_1_0=", "GST_REGISTRY=/dev/null", "GST_REGISTRY_UPDATE=no", "GST_REGISTRY_FORK=no")
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start Voice runtime check: %w", err)
	}
	waited := false
	defer func() {
		_ = stdin.Close()
		if !waited {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	exchanges := []struct {
		request  map[string]any
		response string
	}{
		{map[string]any{"type": "hello", "protocol": 1, "buildCommit": commit}, "ready"},
		{map[string]any{"type": "initializeRuntime"}, "runtimeReady"},
		{map[string]any{"type": "close"}, "closed"},
	}
	for _, e := range exchanges {
		payload, _ := json.Marshal(e.request)
		if err := binary.Write(stdin, binary.BigEndian, uint32(len(payload))); err != nil {
			return fmt.Errorf("Voice runtime control write failed")
		}
		if _, err := stdin.Write(payload); err != nil {
			return fmt.Errorf("Voice runtime control write failed")
		}
		var size uint32
		if err := binary.Read(stdout, binary.BigEndian, &size); err != nil {
			return fmt.Errorf("Voice runtime did not report %s", e.response)
		}
		if size == 0 || size > 128*1024 {
			return fmt.Errorf("Voice runtime response exceeds limit")
		}
		b := make([]byte, size)
		if _, err := io.ReadFull(stdout, b); err != nil {
			return fmt.Errorf("incomplete Voice runtime response")
		}
		var response struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(b, &response) != nil || response.Type != e.response {
			return fmt.Errorf("Voice runtime did not report %s", e.response)
		}
	}
	_ = stdin.Close()
	err = cmd.Wait()
	waited = true
	if err != nil {
		return fmt.Errorf("Voice runtime check failed: %w", err)
	}
	return nil
}
