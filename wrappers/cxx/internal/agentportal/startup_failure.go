package agentportal

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// StartupFailureEnv is private to the wrapper child. RequireIdentity removes it
// before provider execution; the relay retains its own open file for readback.
const StartupFailureEnv = "CXX_NATIVE_STARTUP_FAILURE_PATH"

type startupFailure struct {
	Stage  string `json:"stage"`
	Code   string `json:"code"`
	Status int    `json:"status,omitempty"`
}

func validStartupFailure(f startupFailure) bool {
	if f.Stage != "registration" && f.Stage != "connection" && f.Stage != "identity" {
		return false
	}
	switch f.Code {
	case "failed", "api_rejected", "agent_messaging_lease_lost", "agent_session_finished", "agent_identity_conflict":
	default:
		return false
	}
	return f.Status == 0 || (f.Status >= 400 && f.Status <= 599)
}

func recordStartupFailure(stage string, err error) {
	if err == nil {
		return
	}
	path := os.Getenv(StartupFailureEnv)
	if path == "" {
		return
	}
	f := startupFailure{Stage: stage, Code: "failed"}
	var apiErr *PortalError
	if errors.As(err, &apiErr) {
		f.Status, f.Code = apiErr.Status, "api_rejected"
		switch apiErr.Code {
		case "agent_messaging_lease_lost", "agent_session_finished", "agent_identity_conflict":
			f.Code = apiErr.Code
		}
	}
	if !validStartupFailure(f) {
		return
	}
	// The relay creates this private file. Never create a caller-selected path,
	// overwrite an existing record, or copy free-form error messages into it.
	file, openErr := os.OpenFile(path, os.O_WRONLY, 0)
	if openErr != nil {
		return
	}
	defer file.Close()
	stat, statErr := file.Stat()
	if statErr != nil || !stat.Mode().IsRegular() || stat.Mode().Perm() != 0600 || stat.Size() != 0 {
		return
	}
	_ = json.NewEncoder(file).Encode(f)
}

// Successful identity confirmation supersedes any transient startup failure.
func clearStartupFailure() {
	file, err := os.OpenFile(os.Getenv(StartupFailureEnv), os.O_WRONLY, 0)
	if err != nil {
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err == nil && stat.Mode().IsRegular() && stat.Mode().Perm() == 0600 {
		_ = file.Truncate(0)
	}
}

// ReadStartupFailure accepts only bounded, enumerated diagnostic fields. It is
// evidence for operators, never permission to retry a possibly started child.
func ReadStartupFailure(reader io.Reader) string {
	var f startupFailure
	raw, err := io.ReadAll(io.LimitReader(reader, 257))
	if err != nil || len(raw) > 256 || json.Unmarshal(raw, &f) != nil || !validStartupFailure(f) {
		return ""
	}
	if f.Status != 0 {
		return fmt.Sprintf("startup stage=%s code=%s http=%d", f.Stage, f.Code, f.Status)
	}
	return fmt.Sprintf("startup stage=%s code=%s", f.Stage, f.Code)
}
