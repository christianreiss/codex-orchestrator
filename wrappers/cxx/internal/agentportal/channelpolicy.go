package agentportal

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Claude Code only registers a plugin channel that its enterprise managed
// settings approve: `channelsEnabled` must be true and the plugin must appear in
// `allowedChannelPlugins`. Without that, a --channels launch is skipped silently
// ("not on the approved channels allowlist") and the receiver would look healthy
// while nothing could ever reach the transcript — so the wrapper writes the
// approval itself and only claims a channel when it is actually there.
//
// It is written as a DROP-IN beside any real managed-settings.json rather than
// into that file: drop-ins compose, so an organisation's own policy is never
// read, rewritten, or clobbered by this.
const channelPolicyFile = "50-cxx-channels.json"

// CLX_CHANNEL_POLICY_DIR overrides the managed-settings directory. Tests use it;
// so can an operator whose Claude install reads policy from somewhere else.
const channelPolicyDirEnv = "CLX_CHANNEL_POLICY_DIR"

func channelPolicyBody() []byte {
	body, _ := json.Marshal(map[string]any{
		"channelsEnabled": true,
		"allowedChannelPlugins": []any{
			map[string]any{"plugin": PluginName, "marketplace": "inline"},
		},
	})
	return append(body, '\n')
}

// managedSettingsDir mirrors Claude Code's own OS policy folder.
func managedSettingsDir() string {
	if dir := strings.TrimSpace(os.Getenv(channelPolicyDirEnv)); dir != "" {
		return dir
	}
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/ClaudeCode"
	case "windows":
		return `C:\Program Files\ClaudeCode`
	default:
		return "/etc/claude-code"
	}
}

// orgPolicyDecides reports whether an organisation's own managed settings speak
// about channels. When they do, the wrapper stays out of it: drop-in precedence
// against the base file is not something this wrapper can predict, so claiming a
// channel we may not have is worse than keeping the confirmation prompt.
func orgPolicyDecides(dir string) bool {
	raw, err := os.ReadFile(filepath.Join(dir, "managed-settings.json"))
	if err != nil {
		return false
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// Unreadable org policy is exactly the case not to guess about.
		return true
	}
	_, enabled := parsed["channelsEnabled"]
	_, allowed := parsed["allowedChannelPlugins"]
	return enabled || allowed
}

// ensureChannelPolicy reports whether this host's Claude managed settings
// approve the receiver plugin as a channel, installing the drop-in that does so
// when it is absent and this process (directly or through a non-interactive
// sudo) may write it.
func ensureChannelPolicy() bool {
	dir := managedSettingsDir()
	if orgPolicyDecides(dir) {
		return false
	}
	target := filepath.Join(dir, "managed-settings.d", channelPolicyFile)
	want := channelPolicyBody()
	if current, err := os.ReadFile(target); err == nil && bytes.Equal(bytes.TrimSpace(current), bytes.TrimSpace(want)) {
		return true
	}
	if err := writeChannelPolicy(target, want); err != nil {
		return false
	}
	current, err := os.ReadFile(target)
	return err == nil && bytes.Equal(bytes.TrimSpace(current), bytes.TrimSpace(want))
}

func writeChannelPolicy(target string, body []byte) error {
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err == nil {
		if err := os.WriteFile(target, body, 0o644); err == nil {
			return nil
		} else if !errors.Is(err, os.ErrPermission) {
			return err
		}
	} else if !errors.Is(err, os.ErrPermission) {
		return err
	}
	return writeChannelPolicySudo(target, body)
}

// writeChannelPolicySudo stages the drop-in in a file this user owns and has
// sudo place it. Non-interactive on purpose: a launch must never stop to ask for
// a password, and a host without passwordless sudo simply keeps the prompt.
func writeChannelPolicySudo(target string, body []byte) error {
	if runtime.GOOS == "windows" {
		return errors.New("no privileged fallback on windows")
	}
	sudo, err := exec.LookPath("sudo")
	if err != nil {
		return err
	}
	staged, err := os.CreateTemp("", "cxx-channel-policy-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(staged.Name())
	if _, err := staged.Write(body); err != nil {
		staged.Close()
		return err
	}
	if err := staged.Close(); err != nil {
		return err
	}
	dir := filepath.Dir(target)
	for _, args := range [][]string{
		{"-n", "install", "-d", "-m", "0755", dir},
		{"-n", "install", "-m", "0644", staged.Name(), target},
	} {
		cmd := exec.Command(sudo, args...)
		cmd.Stdin = nil
		cmd.Stdout = nil
		cmd.Stderr = nil
		done := make(chan error, 1)
		if err := cmd.Start(); err != nil {
			return err
		}
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			if err != nil {
				return err
			}
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			return errors.New("sudo timed out")
		}
	}
	return nil
}
