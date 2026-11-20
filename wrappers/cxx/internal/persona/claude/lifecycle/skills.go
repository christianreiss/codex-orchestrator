// Package lifecycle — skills.go handles the legacy skill fingerprint fallback.
//
// Current servers send native fallback Skills, or an explicit empty set when
// MCP supplies Skill content, in /sync/bootstrap. collections.go reconciles only
// fleet-owned files before launch. Older servers
// that omit claude_skills use the fingerprint probe below instead:
//
//  1. Probe `GET /skills?engine=claude` once per run, hash the
//     (slug, sha256) fingerprint of the list, and compare against
//     the cached digest under ~/.cache/codex-orchestrator/clx-skills-digest.
//     Any change marks the boot screen's "skills" dot as updated.
//
// `~/.claude/skills` is the fleet-managed native skill fallback store
// reconciled by applyClaudeSkills. MCP content does not register native
// Claude Code Skills.
//
// The probe is best-effort: any failure is logged at debug and the
// caller never refuses to launch over it.
package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/observability/tracing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/summary"
)

func skillsDigestPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".cache", "codex-orchestrator", "clx-skills-digest")
}

func syncSkills(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) (state summary.ResourceSync) {
	if client != nil && communicator.SyncManaged(client.BaseURL) {
		out, err := sharedSync(ctx, client, "", "skills", false, false, nil)
		state = resourceFromWire(out.Resources["skills"])
		state.Err = errors.Join(state.Err, err)
		return state
	}
	ctx, span := tracing.Start(ctx, "cxx.sync.skills", tracing.String("wrapper.engine", "claude"))
	defer func() {
		span.SetBool("wrapper.skills_changed", state.Updated)
		span.Fail(state.Err)
		span.End()
	}()

	state = summary.ResourceSync{Checked: true}
	if client == nil {
		state.Err = errors.New("skills client unavailable")
		return state
	}
	list, err := client.ListSkills(ctx)
	if err != nil {
		logger.Debug("skills sync skipped", "err", err)
		state.Err = err
		return state
	}
	cached, err := readSkillsDigestResult()
	if err != nil {
		logger.Debug("skills digest read failed", "err", err)
		state.Err = err
		return state
	}
	if len(list) == 0 {
		state.Updated = cached != ""
		state.Err = writeSkillsDigest("")
		return state
	}
	fp := fingerprintSkills(list)
	if fp == cached {
		return state
	}
	state.Updated = true
	state.Err = writeSkillsDigest(fp)
	return state
}

// fingerprintSkills builds a stable hex digest over the (slug, sha256) pairs
// in the server response. Order-independent: the list is sorted before hashing
// so the server's row order doesn't matter. (sha256 already changes whenever a
// skill body changes, so there's no separate version to fold in — the server
// never emits one.)
func fingerprintSkills(list []orchestrator.Skill) string {
	pairs := make([]string, 0, len(list))
	for _, s := range list {
		pairs = append(pairs, s.Slug+"|"+s.SHA256)
	}
	sort.Strings(pairs)
	h := sha256.Sum256([]byte(strings.Join(pairs, "\n")))
	return hex.EncodeToString(h[:])
}

func readSkillsDigest() string {
	digest, _ := readSkillsDigestResult()
	return digest
}

func readSkillsDigestResult() (string, error) {
	p := skillsDigestPath()
	if p == "" {
		return "", errors.New("skills digest path unavailable")
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

func writeSkillsDigest(fp string) error {
	p := skillsDigestPath()
	if p == "" {
		return errors.New("skills digest path unavailable")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp := p + ".new"
	if err := os.WriteFile(tmp, []byte(fp+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}
