// Package lifecycle — skills.go drives the orchestrator-side skills sync.
//
// v2 skills are read live via MCP (`resource_read skill://<slug>`) so the
// wrapper never persists the manifest bodies to disk. What it does is:
//
//  1. Probe `GET /skills?engine=codex` once per run, hash the (slug, sha256)
//     fingerprint of the list, and compare against the cached digest under
//     ~/.cache/codex-orchestrator/skills-digest. Any change marks the boot
//     screen's "skills" dot as updated.
//  2. One-shot purge of the legacy on-disk skill caches (`~/.agents/skills`,
//     `~/.codex/skills`, `~/.codex/prompts`) the first time we boot at this
//     wrapper version — they would otherwise shadow the MCP-served copies.
//
// Both operations are best-effort: any failure is logged at debug and the
// caller never refuses to launch over it.
package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/summary"
)

func skillsDigestPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".cache", "codex-orchestrator", "skills-digest")
}

func legacyCleanupSentinel(version string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	if version == "" {
		version = "dev"
	}
	return filepath.Join(home, ".cache", "codex-orchestrator", "cleanup-v"+version)
}

// syncSkills pings /skills and returns a truthful best-effort health result.
// Failures remain non-fatal, but callers must render them as warnings rather
// than treating "not updated" as proof that the resource is healthy.
func syncSkills(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) summary.ResourceSync {
	state := summary.ResourceSync{Checked: true}
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
		// Treat empty server-side list as the absence of a fingerprint — but
		// still write an empty cache so a later non-empty response registers
		// as a change.
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

// pruneLegacySkillDirs deletes the bash-era on-disk skill caches once per
// wrapper version (sentinel-gated). v2 reads skills via MCP only; leaving the
// old trees in place would let stale manifests shadow live ones.
func pruneLegacySkillDirs(version string, logger *slog.Logger) summary.ResourceSync {
	return pruneLegacySkillDirsWith(version, logger, os.RemoveAll)
}

func pruneLegacySkillDirsWith(version string, logger *slog.Logger, removeAll func(string) error) summary.ResourceSync {
	state := summary.ResourceSync{Checked: true}
	sentinel := legacyCleanupSentinel(version)
	if sentinel == "" {
		state.Err = errors.New("legacy skill cleanup sentinel path unavailable")
		return state
	}
	if _, err := os.Stat(sentinel); err == nil {
		return state // already cleaned for this wrapper version
	} else if !os.IsNotExist(err) {
		state.Err = err
		return state
	}
	home, err := os.UserHomeDir()
	if err != nil {
		state.Err = err
		return state
	}
	codexHome, err := codex.CodexHome()
	if err != nil {
		state.Err = err
		return state
	}
	targets := []string{
		filepath.Join(home, ".agents", "skills"),
		filepath.Join(codexHome, "skills"),
		filepath.Join(codexHome, "prompts"),
	}
	for _, t := range targets {
		if _, err := os.Stat(t); os.IsNotExist(err) {
			continue
		} else if err != nil {
			state.Err = errors.Join(state.Err, fmt.Errorf("stat %s: %w", t, err))
			continue
		}
		if err := removeAll(t); err != nil {
			logger.Debug("legacy skill dir prune failed", "path", t, "err", err)
			state.Err = errors.Join(state.Err, fmt.Errorf("prune %s: %w", t, err))
			continue
		}
		state.Updated = true
		logger.Debug("pruned legacy skill cache", "path", t)
	}
	if state.Err != nil {
		return state
	}
	// Drop the sentinel only after a complete successful pass so any partial
	// prune retries on the next run and remains visible as an attention state.
	if err := os.MkdirAll(filepath.Dir(sentinel), 0o700); err != nil {
		state.Err = err
		return state
	}
	if err := os.WriteFile(sentinel, []byte(version+"\n"), 0o600); err != nil {
		state.Err = err
	}
	return state
}
