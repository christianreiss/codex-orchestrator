// Package uninstall applies server-confirmed lifecycle decisions to shared cxx
// artifacts. Persona uninstallers own only engine-local state.
package uninstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentbus"
	hostcron "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
)

type ServerResult struct {
	Confirmed        bool
	LastHost         bool
	RemainingEngines []string
}

type Disposition int

const (
	PreserveShared Disposition = iota
	RemoveSelectedAlias
	RemoveAllShared
)

var removeCron = hostcron.Remove
var removeAgentService = func() error {
	return agentbus.RemoveService(io.Discard, io.Discard)
}

func Decide(result ServerResult) Disposition {
	if !result.Confirmed {
		return PreserveShared
	}
	if result.LastHost {
		return RemoveAllShared
	}
	if len(result.RemainingEngines) > 0 {
		return RemoveSelectedAlias
	}
	return PreserveShared
}

// DecodeServerResult accepts both the root and data envelope shapes. A
// successful whole-host delete uses `deleted`, while a partial delete returns
// `remaining_engines` (which may itself be empty in future API versions).
func DecodeServerResult(r io.Reader) (ServerResult, error) {
	type payload struct {
		Remaining *[]string       `json:"remaining_engines"`
		Deleted   json.RawMessage `json:"deleted"`
	}
	var envelope struct {
		payload
		Data payload `json:"data"`
	}
	if err := json.NewDecoder(r).Decode(&envelope); err != nil {
		return ServerResult{}, err
	}
	rootSet := envelope.Remaining != nil || len(envelope.Deleted) > 0
	dataSet := envelope.Data.Remaining != nil || len(envelope.Data.Deleted) > 0
	if !rootSet && !dataSet {
		return ServerResult{}, errors.New("delete response did not confirm remaining engine state")
	}
	var rootResult, dataResult ServerResult
	var rootErr, dataErr error
	if rootSet {
		rootResult, rootErr = decodePayload(envelope.payload)
	}
	if dataSet {
		dataResult, dataErr = decodePayload(envelope.Data)
	}
	if rootErr != nil {
		return ServerResult{}, rootErr
	}
	if dataErr != nil {
		return ServerResult{}, dataErr
	}
	if rootSet && dataSet {
		if !reflect.DeepEqual(rootResult, dataResult) {
			return ServerResult{}, errors.New("delete response root and data states disagree")
		}
		return rootResult, nil
	}
	if rootSet {
		return rootResult, nil
	}
	return dataResult, nil
}

func decodePayload(selected struct {
	Remaining *[]string       `json:"remaining_engines"`
	Deleted   json.RawMessage `json:"deleted"`
}) (ServerResult, error) {
	if selected.Remaining != nil && len(selected.Deleted) > 0 {
		return ServerResult{}, errors.New("delete response contains both remaining_engines and deleted")
	}
	if selected.Remaining != nil {
		remaining, err := validateRemaining(*selected.Remaining)
		if err != nil {
			return ServerResult{}, err
		}
		return ServerResult{Confirmed: true, RemainingEngines: remaining}, nil
	}
	if confirmsLastHost(selected.Deleted) {
		return ServerResult{Confirmed: true, LastHost: true}, nil
	}
	return ServerResult{}, errors.New("delete response did not confirm remaining engine state")
}

func validateRemaining(raw []string) ([]string, error) {
	if len(raw) == 0 {
		return nil, errors.New("remaining_engines is empty without last-host confirmation")
	}
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, engine := range raw {
		engine = strings.ToLower(strings.TrimSpace(engine))
		if engine != layout.EngineCodex && engine != layout.EngineClaude {
			return nil, fmt.Errorf("remaining_engines contains unknown engine %q", engine)
		}
		if seen[engine] {
			return nil, fmt.Errorf("remaining_engines contains duplicate engine %q", engine)
		}
		seen[engine] = true
		out = append(out, engine)
	}
	return out, nil
}

func confirmsLastHost(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var flag bool
	if json.Unmarshal(raw, &flag) == nil {
		return flag
	}
	var identity string
	if json.Unmarshal(raw, &identity) != nil {
		return false
	}
	identity = strings.TrimSpace(identity)
	return identity != "" && !strings.EqualFold(identity, "false") && identity != "0"
}

// Apply mutates shared artifacts only from confirmed server state. Network,
// HTTP, or decode uncertainty deliberately preserves cxx, both aliases, and
// the host-wide cron entry.
func Apply(ctx context.Context, result ServerResult, selectedEngine, executable string) error {
	selectedEngine = strings.ToLower(strings.TrimSpace(selectedEngine))
	if selectedEngine != layout.EngineCodex && selectedEngine != layout.EngineClaude {
		return fmt.Errorf("unknown selected engine %q", selectedEngine)
	}
	if result.LastHost && len(result.RemainingEngines) > 0 {
		return errors.New("last-host result also contains remaining engines")
	}
	if result.Confirmed && !result.LastHost {
		if len(result.RemainingEngines) == 0 {
			return errors.New("confirmed partial uninstall has no remaining engine")
		}
		for _, engine := range result.RemainingEngines {
			if engine == selectedEngine {
				return fmt.Errorf("remaining_engines still contains selected engine %q", selectedEngine)
			}
			if engine != layout.EngineCodex && engine != layout.EngineClaude {
				return fmt.Errorf("remaining_engines contains unknown engine %q", engine)
			}
		}
	}
	switch Decide(result) {
	case PreserveShared:
		return nil
	case RemoveSelectedAlias:
		canonical, err := layout.CanonicalExecutable(executable)
		if err != nil {
			return err
		}
		return layout.RemoveAlias(ctx, filepath.Dir(canonical), selectedEngine)
	case RemoveAllShared:
		if err := removeAgentService(); err != nil {
			// Do not erase the binary, aliases, cron recovery path, or relay
			// state while a service manager may still have a live worker.
			return fmt.Errorf("remove agent relay service: %w", err)
		}
		cronErr := removeCron(ctx)
		layoutErr := layout.RemoveShared(ctx, executable)
		return errors.Join(cronErr, layoutErr)
	default:
		return fmt.Errorf("unknown uninstall disposition")
	}
}
