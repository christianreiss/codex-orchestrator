//go:build linux

package communicator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
	"github.com/google/uuid"
)

type residentAdoption struct {
	path    string
	journal residency.Journal
}

// Adoption stages immutable bytes and persists the exact source before asking
// it to fence. Retries retain the handoff ID; an ambiguous prepare never permits
// successor admission. No process signal or execution replay is used.
func adoptOnDemandOwner(ctx context.Context, base string) (*residentAdoption, error) {
	dir, namespace, err := residentCoordination(base)
	if err != nil {
		return nil, err
	}
	exe := "/proc/self/exe"
	target, err := residency.DigestFile(exe)
	if err != nil {
		return nil, err
	}
	entries, err := filepath.Glob(filepath.Join(dir, "adopt-*.json"))
	if err != nil {
		return nil, err
	}
	var adoption *residentAdoption
	for _, path := range entries {
		j, err := residency.ReadJournal(path)
		if err != nil {
			return nil, err
		}
		if j.Phase == residency.Reopened {
			continue
		}
		if adoption != nil || j.Target != target || j.Namespace != namespace {
			return nil, errors.New("another owner adoption remains pending")
		}
		adoption = &residentAdoption{path, j}
	}
	socket, err := discoverResidentOwner(ctx, base)
	if err != nil {
		return nil, err
	}
	if socket == "" {
		if adoption == nil {
			return nil, nil
		}
		if adoption.journal.Phase != residency.HandoffReady {
			return nil, errors.New("source unavailable before durable handoff readiness; adoption deferred")
		}
		exited, err := adoptionSourceExited(adoption.journal)
		if err != nil || !exited {
			return nil, errors.New("pending adoption has no verified source exit")
		}
		return adoption, nil
	}
	record, err := readResidentOwner(base)
	if err != nil || record.Socket != socket {
		return nil, errors.New("owner changed during adoption")
	}
	client := unixClient(socket, time.Second)
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://communicator.local/_comm/status", nil)
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	var status struct {
		Mode     string `json:"mode"`
		Instance string `json:"owner_instance_id"`
		PID      int    `json:"pid"`
		Protocol int    `json:"runtime_protocol"`
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&status)
	response.Body.Close()
	if err != nil {
		return nil, err
	}
	if status.Instance != record.Instance || status.PID != record.PID || status.Protocol != residency.Protocol {
		return nil, errors.New("owner identity changed during adoption")
	}
	if status.Mode != "on_demand" {
		return nil, errors.New("namespace already has a resident owner")
	}
	sourcePath := fmt.Sprintf("/proc/%d/exe", record.PID)
	digest, err := residency.DigestFile(sourcePath)
	if err != nil {
		return nil, err
	}
	process, err := residency.PinProcess(record.PID, os.Getuid(), digest)
	if err != nil {
		return nil, err
	}
	defer process.Close()
	if adoption == nil {
		adoption = &residentAdoption{path: filepath.Join(dir, "adopt-"+record.Instance+".json"), journal: residency.Journal{TransitionID: uuid.NewString(), Source: digest, Target: target, SourceOwner: record.Instance, SourcePID: record.PID, SourceStart: process.Start, SourceBoot: process.Boot, Namespace: namespace, Phase: residency.Observed}}
		if err := residency.CreateJournal(adoption.path, adoption.journal); err != nil {
			return nil, err
		}
	}
	j := adoption.journal
	if j.SourceOwner != record.Instance || j.SourcePID != record.PID || j.SourceStart != process.Start || j.SourceBoot != process.Boot || j.Source != digest {
		return nil, errors.New("pending adoption belongs to a different source")
	}
	if _, err := residency.StageBinary(sourcePath, filepath.Join(dir, "staged"), digest); err != nil {
		return nil, err
	}
	if _, err := residency.StageBinary(exe, filepath.Join(dir, "staged"), target); err != nil {
		return nil, err
	}
	evidence := residency.Evidence{AdmissionFenced: true, WorkloadVerified: true}
	if j.Phase == residency.Observed {
		if err := adoption.advance(residency.Staged, evidence); err != nil {
			return nil, err
		}
	}
	send := func(command string) error {
		body, _ := json.Marshal(map[string]string{"request_id": adoption.journal.TransitionID, "owner_instance_id": record.Instance, "command": command})
		req, err := http.NewRequestWithContext(ctx, "POST", "http://communicator.local/_comm/handoff", bytes.NewReader(body))
		if err != nil {
			return err
		}
		response, err := client.Do(req)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		var reply struct {
			Accepted  bool   `json:"accepted"`
			RequestID string `json:"request_id"`
			Instance  string `json:"owner_instance_id"`
		}
		if response.StatusCode != http.StatusOK {
			return errors.New("on-demand owner is busy or refused handoff")
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&reply); err != nil {
			return err
		}
		if !reply.Accepted || reply.RequestID != adoption.journal.TransitionID || reply.Instance != record.Instance {
			return errors.New("handoff acknowledgement identity mismatch")
		}
		return nil
	}
	// Prepare is idempotent and does not terminate. Its confirmed proof of fenced,
	// quiet local admission is durably recorded before committing the exit.
	if adoption.journal.Phase == residency.Staged {
		if err := send("prepare"); err != nil {
			return nil, err
		}
		if err := adoption.advance(residency.Fenced, evidence); err != nil {
			return nil, err
		}
	}
	if adoption.journal.Phase == residency.Fenced {
		if err := adoption.advance(residency.Draining, evidence); err != nil {
			return nil, err
		}
	}
	if adoption.journal.Phase == residency.Draining {
		if err := adoption.advance(residency.HandoffReady, evidence); err != nil {
			return nil, err
		}
	}
	if adoption.journal.Phase != residency.HandoffReady {
		return nil, errors.New("adoption needs recovery of an already replaced target")
	}
	_ = send("commit") // A lost commit ACK is resolved only by kernel exit proof.
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := process.WaitExited(wait); err != nil {
		return nil, fmt.Errorf("adoption pending; process exit unproven: %w", err)
	}
	return adoption, nil
}

func adoptionSourceExited(j residency.Journal) (bool, error) {
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return false, err
	}
	if string(bytes.TrimSpace(boot)) != j.SourceBoot {
		return true, nil
	}
	info, err := os.Stat(fmt.Sprintf("/proc/%d", j.SourcePID))
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	_ = info
	// An extant PID is deliberately inconclusive after recovery: do not infer
	// permission from a reused PID, zombie, or a guessed successor.
	return false, nil
}

func (a *residentAdoption) advance(phase residency.Phase, evidence residency.Evidence) error {
	next := a.journal
	next.Phase = phase
	if phase == residency.Replaced {
		next.TargetOwner = processInstance
	}
	if err := residency.AdvanceJournal(a.path, a.journal, next, evidence); err != nil {
		return err
	}
	a.journal = next
	return nil
}

func (a *residentAdoption) acquired() error {
	if a == nil {
		return nil
	}
	evidence := residency.Evidence{AdmissionFenced: true, WorkloadVerified: true, SourceExited: true, OwnerAcquired: true, TargetVerified: true}
	for _, phase := range []residency.Phase{residency.Replaced, residency.Verified, residency.Reopened} {
		if err := a.advance(phase, evidence); err != nil {
			return err
		}
	}
	return nil
}
