package communicator

import "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"

// A bounded diagnostic report, never admission or exit evidence. Deliberately
// omits errors, paths, account identities and native session contents.
type residentReport struct {
	Sequence         uint64                   `json:"sequence"`
	Type             string                   `json:"type"`
	OwnerInstanceID  string                   `json:"owner_instance_id"`
	RuntimeProtocol  int                      `json:"runtime_protocol"`
	Mode             string                   `json:"mode"`
	Managed          bool                     `json:"managed"`
	ResidentEnabled  bool                     `json:"resident_enabled"`
	ExecutionEnabled bool                     `json:"execution_enabled"`
	BinarySHA256     string                   `json:"binary_sha256"`
	Draining         bool                     `json:"draining"`
	LocalRequests    int                      `json:"local_requests"`
	LegacyClients    int                      `json:"legacy_clients"`
	Execution        *residentExecutionReport `json:"execution"`
}

type residentExecutionReport struct {
	Running  bool               `json:"running"`
	Fenced   bool               `json:"fenced"`
	Verified bool               `json:"verified"`
	Workload residency.Workload `json:"workload"`
}

func reportCount(n int) int {
	return min(1_000_000, max(0, n))
}

func (s *server) residentReport() *residentReport {
	state := s.residentState
	if state == nil {
		return nil // The signed runtime capability remains default-off.
	}
	state.mu.Lock()
	r := &residentReport{Type: "resident_status", OwnerInstanceID: processInstance,
		RuntimeProtocol: residency.Protocol, Mode: "on_demand", Managed: state.managed,
		ResidentEnabled: state.policy.ResidentEnabled, ExecutionEnabled: state.policy.executionEnabled(),
		Draining: s.draining.Load(), LocalRequests: reportCount(state.pending), LegacyClients: reportCount(state.legacyClients)}
	controller := state.controller
	if state.managed && s.resident.Load() {
		r.Mode = "resident"
	}
	state.mu.Unlock()
	r.BinarySHA256 = processExecutableDigest()
	if len(r.BinarySHA256) != 64 {
		return nil
	}
	if controller != nil {
		status := controller.Status()
		w := status.Workload
		w.Accepted, w.PeerClaims = reportCount(w.Accepted), reportCount(w.PeerClaims)
		w.Children, w.Receipts = reportCount(w.Children), reportCount(w.Receipts)
		w.Writes, w.Requests = reportCount(w.Writes), reportCount(w.Requests)
		w.LegacyClients = reportCount(w.LegacyClients)
		r.Execution = &residentExecutionReport{Running: status.Running, Fenced: status.Fenced, Verified: status.Verified, Workload: w}
	}
	return r
}

func (c *connection) sendResidentReport() error {
	c.residentSendMu.Lock()
	defer c.residentSendMu.Unlock()
	c.mu.Lock()
	ready, report := c.residentReporting, c.residentReport
	c.mu.Unlock()
	if !ready || report == nil {
		return nil
	}
	if value := report(); value != nil {
		c.residentSequence++
		value.Sequence = c.residentSequence
		return c.send(value)
	}
	return nil
}
