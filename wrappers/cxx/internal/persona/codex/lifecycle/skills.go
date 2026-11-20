// Package lifecycle — skills.go drives the orchestrator-side skills sync.
//
// v2 skills are read live via MCP (`resource_read skill://<slug>`) so the
// wrapper never persists the manifest bodies to disk. What it does is:
//
//  1. Probe `GET /skills?engine=codex` once per run, hash the (slug, sha256)
//     fingerprint of the list, and compare against the cached digest under
//     ~/.cache/codex-orchestrator/skills-digest. Any change marks the boot
//     screen's "skills" dot as updated.
//
// The probe is best-effort: any failure is logged at debug and the
// caller never refuses to launch over it.
package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/observability/tracing"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/summary"
)

func skillsDigestPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".cache", "codex-orchestrator", "skills-digest")
}

// syncSkills pings /skills and returns a truthful best-effort health result.
// Failures remain non-fatal, but callers must render them as warnings rather
// than treating "not updated" as proof that the resource is healthy.
func syncSkills(ctx context.Context, client *orchestrator.Client, logger *slog.Logger) summary.ResourceSync {
	return syncSkillsListed(ctx, client, logger, nil)
}

// skillsListing is a /skills response fetched ahead of time.
type skillsListing struct {
	list []orchestrator.Skill
	err  error
}

// prefetchSkills starts the read-only /skills request so it overlaps the
// bundle round-trip. The returned function blocks for the result.
func prefetchSkills(ctx context.Context, client *orchestrator.Client) func() skillsListing {
	ch := make(chan skillsListing, 1)
	go func() {
		if client == nil {
			ch <- skillsListing{err: errors.New("skills client unavailable")}
			return
		}
		list, err := client.ListSkills(ctx)
		ch <- skillsListing{list: list, err: err}
	}()
	return func() skillsListing { return <-ch }
}

// startManagedSkills runs the shared skills operation in the background and returns the
// function that waits for its result. It is the managed counterpart of prefetchSkills:
// the same read, but performed (and its digest written) by the communicator's worker.
func startManagedSkills(ctx context.Context, client *orchestrator.Client) func() summary.ResourceSync {
	ch := make(chan summary.ResourceSync, 1)
	go func() {
		path, _ := codex.AuthPath()
		out, err := sharedSync(ctx, client, path, "skills", false, false, nil)
		result := resourceFromWire(out.Resources["skills"])
		result.Err = errors.Join(result.Err, err)
		ch <- result
	}()
	return func() summary.ResourceSync { return <-ch }
}

// syncSkillsListed is syncSkills with an optional prefetched listing. A nil
// listing fetches inline. Only the network read is ever overlapped; the digest
// compare and write still happen here, after the bundle has been applied.
func syncSkillsListed(ctx context.Context, client *orchestrator.Client, logger *slog.Logger, prefetched *skillsListing) (state summary.ResourceSync) {
	if communicator.SyncManaged(client.BaseURL) {
		path, _ := codex.AuthPath()
		out, err := sharedSync(ctx, client, path, "skills", false, false, nil)
		result := resourceFromWire(out.Resources["skills"])
		result.Err = errors.Join(result.Err, err)
		return result
	}

	ctx, span := tracing.Start(ctx, "cxx.sync.skills", tracing.String("wrapper.engine", "codex"))
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
	var (
		list []orchestrator.Skill
		err  error
	)
	if prefetched != nil {
		list, err = prefetched.list, prefetched.err
	} else {
		list, err = client.ListSkills(ctx)
	}
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
