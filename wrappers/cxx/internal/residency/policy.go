// Package residency defines the admission and migration invariants shared by
// the resident service and the local communicator. It never launches work.
package residency

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

const Protocol = 1

// Namespace keeps custom runtime roots distinct while login, service and cron
// clients using the standard logind root share the default namespace.
func Namespace(uid int, explicitRoot string) (string, error) {
	if uid < 0 || strings.ContainsRune(explicitRoot, 0) {
		return "", errors.New("invalid runtime namespace")
	}
	if explicitRoot == "" {
		return "default", nil
	}
	if !filepath.IsAbs(explicitRoot) {
		return "", errors.New("runtime namespace must be absolute")
	}
	root := filepath.Clean(explicitRoot)
	if root == fmt.Sprintf("/run/user/%d", uid) {
		return "default", nil
	}
	return "root:" + root, nil
}

// Key identifies ownership, not credentials. Including the namespace prevents
// short socket fallbacks from collapsing separate explicit runtime roots.
func Key(uid int, base, namespace string) string {
	raw := fmt.Sprintf("%d\x00%s\x00%s", uid, strings.TrimRight(base, "/"), namespace)
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:16])
}

type Workload struct {
	Accepted      int `json:"accepted"`
	PeerClaims    int `json:"peer_claims"`
	Children      int `json:"children"`
	Receipts      int `json:"receipts"`
	Writes        int `json:"writes"`
	Requests      int `json:"requests"`
	LegacyClients int `json:"legacy_clients"`
}

// Quiet is deliberately independent of the communicator's lease count. New
// clients can reconnect, but accepted work and legacy clients cannot be erased
// merely because their transport disconnected.
func (w Workload) Quiet() bool {
	return w.Accepted == 0 && w.PeerClaims == 0 && w.Children == 0 &&
		w.Receipts == 0 && w.Writes == 0 && w.Requests == 0 && w.LegacyClients == 0
}

func KeepResident(explicit, executionAccepting bool, w Workload) bool {
	return explicit || executionAccepting || !w.Quiet()
}

type Phase string

const (
	Observed     Phase = "observed"
	Staged       Phase = "staged"
	Fenced       Phase = "fenced"
	Draining     Phase = "draining"
	HandoffReady Phase = "handoff_ready"
	Replaced     Phase = "replaced"
	Verified     Phase = "verified"
	Reopened     Phase = "reopened"
)

type Evidence struct {
	AdmissionFenced  bool
	WorkloadVerified bool
	Workload         Workload
	SourceExited     bool
	OwnerAcquired    bool
	TargetVerified   bool
}

// Next refuses skipped phases and unsafe ownership transitions. A timeout does
// not constitute evidence of drain, process exit, or target verification.
func Next(from, to Phase, evidence Evidence) error {
	allowed := map[Phase]Phase{Observed: Staged, Staged: Fenced, Fenced: Draining,
		Draining: HandoffReady, HandoffReady: Replaced, Replaced: Verified, Verified: Reopened}
	next, valid := allowed[from]
	if !valid || next != to {
		return fmt.Errorf("invalid migration transition %s -> %s", from, to)
	}
	if to != Staged && !evidence.AdmissionFenced {
		return errors.New("migration admission is not fenced")
	}
	if (to == HandoffReady || to == Replaced) && (!evidence.WorkloadVerified || !evidence.Workload.Quiet()) {
		return errors.New("migration still has accepted work, receipts, writes or dependent clients")
	}
	if to == Replaced && (!evidence.SourceExited || !evidence.OwnerAcquired) {
		return errors.New("source exit and exclusive target ownership are not proven")
	}
	if (to == Verified || to == Reopened) && !evidence.TargetVerified {
		return errors.New("target runtime is not verified")
	}
	return nil
}
