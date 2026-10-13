package communicator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

type syncJob struct {
	Engine string            `json:"engine"`
	Config string            `json:"config"`
	Env    map[string]string `json:"env"`
}

var syncEnvKeys = []string{"HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CDX_CONFIG_PATH", "CLX_CONFIG_PATH", "CGX_CONFIG_PATH"}

func RegisterSync(engine string) {
	if os.Getenv("CXX_COMMUNICATOR_SYNC") == "1" {
		return
	}
	path, err := config.DefaultPathForEngine(engine)
	if err != nil {
		return
	}
	key, err := signing.PublicKey()
	if err != nil {
		return
	}
	cfg, err := config.LoadForEngine(path, key, false, engine)
	if err != nil {
		return
	}
	ep := endpointFor(cfg.Orchestrator.BaseURL)
	if ep == nil {
		return
	}
	job := syncJob{Engine: engine, Config: path, Env: map[string]string{}}
	for _, key := range syncEnvKeys {
		if value, ok := os.LookupEnv(key); ok {
			job.Env[key] = value
		}
	}
	ep.mu.Lock()
	if ep.jobs == nil {
		ep.jobs = map[string]syncJob{}
	}
	ep.jobs[engine] = job
	ep.mu.Unlock()
}

func (s *server) registerJobs(r *http.Request) ([]string, error) {
	var jobs []syncJob
	if err := json.NewDecoder(io.LimitReader(r.Body, 65536)).Decode(&jobs); err != nil {
		return nil, err
	}
	if len(jobs) > 3 {
		return nil, fmt.Errorf("too many sync scopes")
	}
	ids := []string{}
	for _, job := range jobs {
		if job.Engine != "codex" && job.Engine != "claude" && job.Engine != "grok" {
			return nil, fmt.Errorf("invalid engine")
		}
		for key := range job.Env {
			allowed := false
			for _, k := range syncEnvKeys {
				if k == key {
					allowed = true
				}
			}
			if !allowed {
				return nil, fmt.Errorf("invalid sync environment")
			}
		}
		raw, _ := json.Marshal(job)
		sum := sha256.Sum256(raw)
		ids = append(ids, hex.EncodeToString(sum[:]))
	}
	s.mu.Lock()
	for i, job := range jobs {
		s.jobs[ids[i]] = job
		s.jobRefs[ids[i]]++
	}
	s.mu.Unlock()
	return ids, nil
}

func (s *server) syncLoop(ctx context.Context) {
	timer := time.NewTicker(5 * time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-s.dirty:
		}
		// Coalesce a burst of related server updates into one refresh per scope.
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
		s.mu.Lock()
		jobs := make([]syncJob, 0, len(s.jobs))
		for _, job := range s.jobs {
			jobs = append(jobs, job)
		}
		connected := s.conn != nil && s.leases > 0
		s.mu.Unlock()
		if !connected {
			continue
		}
		allOK := true
		for _, job := range jobs {
			exe, err := os.Executable()
			if err != nil {
				allOK = false
				continue
			}
			work, cancel := context.WithTimeout(ctx, 90*time.Second)
			cmd := exec.CommandContext(work, exe, job.Engine, "--config", job.Config, "--allow-concurrent-sync", "sync")
			env := os.Environ()
			for _, key := range syncEnvKeys {
				for i := len(env) - 1; i >= 0; i-- {
					if strings.HasPrefix(env[i], key+"=") {
						env = append(env[:i], env[i+1:]...)
					}
				}
				if value, ok := job.Env[key]; ok {
					env = append(env, key+"="+value)
				}
			}
			cmd.Env = append(env, "CXX_COMMUNICATOR_SYNC=1")
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			if cmd.Run() != nil {
				allOK = false
			}
			cancel()
		}
		if allOK && len(jobs) > 0 {
			s.mu.Lock()
			s.lastSync = time.Now().UTC().Format(time.RFC3339)
			s.mu.Unlock()
		}
	}
}
