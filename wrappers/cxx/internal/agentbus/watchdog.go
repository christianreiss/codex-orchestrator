package agentbus

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// RunWatchdogCommand uses the current private bridge by default. An explicit
// target outside that session uses signed host config, without registering a relay.
func RunWatchdogCommand(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "help" {
		fmt.Fprintln(stdout, "cxx watchdog status [--id UUID | --target agent:UUID]\ncxx watchdog on --task-key KEY --stdin [--target agent:UUID] [--duration 2h] [--progress-timeout 10m] [--version N]\ncxx watchdog off --id UUID --version N\nContinuation text is read from stdin. Keep-alives: 15s; deadline stops future recovery.")
		return 0
	}
	if err := runWatchdog(args, stdin, stdout, stderr); err != nil {
		fmt.Fprintln(stderr, "cxx watchdog:", err)
		return 1
	}
	return 0
}
func runWatchdog(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	action := args[0]
	if action != "status" && action != "on" && action != "off" {
		return errors.New("expected status, on or off")
	}
	flags := newFlagSet("cxx watchdog "+action, stderr)
	target := flags.String("target", "", "explicit agent:UUID target")
	id := flags.String("id", "", "watchdog UUID")
	key := flags.String("task-key", "", "stable key for the current task")
	duration := flags.Duration("duration", 2*time.Hour, "total protection lifetime")
	timeout := flags.Duration("progress-timeout", 10*time.Minute, "maximum time without progress")
	version := flags.Int("version", 0, "version returned by status")
	fromStdin := flags.Bool("stdin", false, "read continuation from stdin")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	body := map[string]any{}
	if *id != "" {
		body["id"] = *id
	}
	if *version > 0 {
		body["version"] = *version
	}
	if action == "on" {
		if *key == "" {
			return errors.New("on requires --task-key and --stdin")
		}
		content, err := readMessageBody(stdin, *fromStdin)
		if err != nil {
			return err
		}
		if *duration < time.Minute || *duration > 7*24*time.Hour || *timeout < time.Minute || *timeout > 7*24*time.Hour || *duration%time.Second != 0 || *timeout%time.Second != 0 {
			return errors.New("duration and progress-timeout must be whole seconds between 1m and 168h")
		}
		body["task_key"], body["continuation"] = *key, content
		body["duration_seconds"], body["progress_timeout_seconds"] = int(duration.Seconds()), int(timeout.Seconds())
	}
	if action == "off" && (*id == "" || *version <= 0) {
		return errors.New("off requires --id and --version from status")
	}
	suffix := map[string]string{"status": "get", "on": "enable", "off": "disable"}[action]
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var out map[string]any
	if strings.TrimSpace(os.Getenv(envSocket)) != "" && *target == "" {
		client, err := sessionClientFromEnv(30 * time.Second)
		if err != nil {
			return err
		}
		if err := client.post(ctx, "watchdog/"+suffix, body, &out); err != nil {
			return err
		}
	} else {
		if action == "on" && *target == "" {
			return errors.New("on outside a managed session requires --target agent:UUID")
		}
		if *target != "" && action != "off" {
			body["target"] = *target
		}
		_, cfg, err := loadMessagingConfigs()
		if err != nil {
			return err
		}
		if cfg == nil {
			return errors.New("no enabled signed fleet configuration")
		}
		client, err := newRelayClient(cfg)
		if err != nil {
			return err
		}
		if err := doJSON(ctx, client.http, client.baseURL, http.MethodPost, "/host/watchdogs/"+suffix, body, map[string]string{"X-API-Key": client.apiKey}, &out); err != nil {
			return err
		}
	}
	return writeJSON(stdout, out)
}
