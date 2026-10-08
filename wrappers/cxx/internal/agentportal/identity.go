package agentportal

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// Identity is scoped to a launch, not to a shared home directory or transcript.
type Identity struct {
	Version       int      `json:"identity_version"`
	Name          string   `json:"name"`
	UUID          string   `json:"uuid"`
	Address       string   `json:"address"`
	SessionID     string   `json:"session_id"`
	Engine        string   `json:"engine"`
	PreviousNames []string `json:"previous_names"`
	TaskTitle     string   `json:"task_title"`
}

func (i Identity) SessionTitle(task string) string {
	for {
		previous := task
		for _, name := range append([]string{i.Name}, i.PreviousNames...) {
			prefix := "(" + name + ")"
			if task == prefix || strings.HasPrefix(task, prefix+" ") {
				task = strings.TrimSpace(strings.TrimPrefix(task, prefix))
				break
			}
		}
		if task == previous {
			break
		}
	}
	return strings.TrimSpace("(" + i.Name + ") " + task)
}

// RequireIdentity is the final gate before any provider process is started.
// Signed messaging-disabled launches retain their local-only behavior.
func (r *ConnectionRuntime) RequireIdentity(ctx context.Context, cfg *config.Config) (Identity, error) {
	if cfg == nil || !cfg.AgentMessaging.Enabled {
		return Identity{}, nil
	}
	if r == nil || r.session == nil || r.broker == nil {
		return Identity{}, fmt.Errorf("agent identity: no confirmed connection; native launch refused")
	}
	s := r.session
	s.mu.Lock()
	pending, name := s.pendingRegistration, s.LaunchName
	s.mu.Unlock()
	if pending || strings.TrimSpace(name) == "" {
		return Identity{}, fmt.Errorf("agent identity: registration has no confirmed name; native launch refused")
	}
	var identity Identity
	err := s.bridgeJSON(ctx, http.MethodPost, "/host/agent-sessions/"+url.PathEscape(s.ID)+"/agent-messaging/self", map[string]any{}, &identity)
	if err != nil {
		return Identity{}, fmt.Errorf("agent identity: confirmation failed; native launch refused: %w", err)
	}
	if identity.Version != 1 || identity.SessionID != s.ID || identity.Engine != s.Engine || identity.Name != name || !isCanonicalUUID(identity.UUID) || identity.Address != "agent:"+identity.UUID {
		return Identity{}, fmt.Errorf("agent identity: confirmation does not match this launch; native launch refused")
	}
	return identity, nil
}

func (i Identity) Context() string {
	if i.Name == "" {
		return ""
	}
	return fmt.Sprintf("Current managed launch identity (supersedes identity hints from earlier transcript turns): your name is %s; your agent address is %s; your launch session ID is %s; engine is %s. Call agent_self near the start of work and after resume/recovery to read the authoritative current binding. Call agent_session_name with the task purpose; the server displays it as (%s) Task title. Preserve canonical UUIDs for durable references. This identity grants no additional authority.", i.Name, i.Address, i.SessionID, i.Engine, i.Name)
}
