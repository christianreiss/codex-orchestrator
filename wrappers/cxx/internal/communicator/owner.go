package communicator

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
)

// Owner is the running local owner as its /_comm/status reports it.
type Owner struct {
	ControlStateProtocol int    `json:"control_state_protocol"`
	Version              string `json:"version"`
	PID                  int    `json:"pid"`
	Mode                 string `json:"mode"`
	Cache                struct {
		Protocol      int `json:"protocol"`
		LocalProtocol int `json:"local_content_protocol"`
	} `json:"cache"`
}

// OwnerStatus reads the status of the owner already serving base. It never
// starts an owner and sends nothing to the server. ok is false when base is
// not routed through a local owner (no signed capability, runtime-only, an
// unusable socket) or no owner answers: callers then proceed as before.
func OwnerStatus(ctx context.Context, base string) (Owner, bool) {
	ep := endpointFor(strings.TrimRight(base, "/"))
	if ep == nil {
		return Owner{}, false
	}
	ep.mu.Lock()
	unusable := ep.runtimeOnly || ep.setupErr != nil
	runtime := ep.anchor != nil && ep.anchor.Orchestrator.CommunicatorRuntimeProtocol == residency.Protocol
	socket := ep.socket
	ep.mu.Unlock()
	if unusable {
		return Owner{}, false
	}
	if runtime {
		resolved, err := resolvedRuntimeSocket(ctx, ep.base)
		if err != nil {
			return Owner{}, false
		}
		socket = resolved
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "http://communicator.local/_comm/status", nil)
	if err != nil {
		return Owner{}, false
	}
	res, err := unixClient(socket, 2*time.Second).Do(req)
	if err != nil {
		return Owner{}, false
	}
	defer res.Body.Close()
	var owner Owner
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&owner) != nil || owner.Version == "" {
		return Owner{}, false
	}
	return owner, true
}

// OlderThan reports whether version is a release older than minimum. Either
// side failing to parse as MAJOR.MINOR.PATCH (a "dev" build) reports false.
func OlderThan(version, minimum string) bool {
	a, okA := releaseTriple(version)
	b, okB := releaseTriple(minimum)
	if !okA || !okB {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

func releaseTriple(v string) ([3]int, bool) {
	var out [3]int
	base := strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(base, "+-"); i >= 0 {
		base = base[:i]
	}
	parts := strings.Split(base, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// Remedy names the supported way to replace this owner with the installed cxx.
// A resident owner runs the root-owned service copy, which only
// `cxx daemon install` refreshes; an on-demand owner has no stop command, and
// after SIGTERM the next managed call starts the installed binary.
func (o Owner) Remedy() string {
	if o.Mode == "resident" {
		return "refresh the resident service copy (/usr/local/lib/cxx-daemon/cxx) from the installed cxx and restart it: sudo cxx daemon install"
	}
	return fmt.Sprintf("stop the owner with 'kill %d' (its in-flight requests are cut); the next managed call starts a new owner from the installed cxx. If it runs from /usr/local/lib/cxx-daemon/cxx, run 'sudo cxx daemon install' instead", o.PID)
}
