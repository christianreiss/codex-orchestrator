package communicator

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/residency"
)

func TestResidentProcessRunsWithoutMessagingClientsOrAccountAdmission(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a real signed runtime fixture")
	}
	root := t.TempDir()
	runtimeRoot, err := os.MkdirTemp("", "cc-resident-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(runtimeRoot)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	key := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	binary := filepath.Join(root, "cxx")
	build := exec.Command("go", "build", "-o", binary, "-ldflags", "-X github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing.buildPublicKeyB64="+key, "./cmd/cxx")
	build.Dir = "../.."
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, output)
	}
	var policyReads, accountCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/auth") {
			accountCalls.Add(1)
		}
		if r.URL.Path == "/host/daemon/config" {
			policyReads.Add(1)
			json.NewEncoder(w).Encode(map[string]any{"enabled": false, "resident_enabled": true, "username": communicatorUsername()})
			return
		}
		w.WriteHeader(404)
	}))
	defer upstream.Close()
	env := append(os.Environ(), "HOME="+root, "XDG_RUNTIME_DIR="+runtimeRoot)
	for _, engine := range []string{"codex", "claude", "grok"} {
		cfg := config.Config{SchemaVersion: 1, Engine: engine, IssuedAt: "2026-10-13T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "resident-fixture", InstallationID: "resident-fixture", CommunicatorRuntimeProtocol: 1}, Host: config.Host{ID: 1, FQDN: "resident.example", Secure: true}, Wrapper: config.Wrapper{Version: "0.9.78", Track: "stable", BinaryURL: upstream.URL + "/download", BinarySHA256: strings.Repeat("0", 64)}}
		path := filepath.Join(root, engine+".json")
		body, _ := json.Marshal(cfg)
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path+".sig", ed25519.Sign(priv, body), 0600); err != nil {
			t.Fatal(err)
		}
		env = append(env, map[string]string{"codex": "CDX_CONFIG_PATH", "claude": "CLX_CONFIG_PATH", "grok": "CGX_CONFIG_PATH"}[engine]+"="+path)
	}

	sum := sha256.Sum256([]byte(upstream.URL))
	socket := filepath.Join(runtimeRoot, "cxx-comm-"+hex.EncodeToString(sum[:8]), "control.sock")
	old := exec.Command(binary, "communicator", "serve", "--config", filepath.Join(root, "codex.json"))
	old.Env = env
	if err := old.Start(); err != nil {
		t.Fatal(err)
	}
	oldDone := make(chan struct{})
	go func() { old.Wait(); close(oldDone) }()
	t.Cleanup(func() {
		select {
		case <-oldDone:
			return
		default:
		}
		old.Process.Kill()
		<-oldDone
	})
	ready := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		res, err := unixClient(socket, time.Second).Get("http://communicator.local/_comm/status")
		if err == nil {
			var status map[string]any
			json.NewDecoder(res.Body).Decode(&status)
			res.Body.Close()
			if status["mode"] == "on_demand" {
				ready = true
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		t.Fatal("on-demand fixture did not become ready")
	}
	cmd := exec.Command(binary, "communicator", "run")
	cmd.Env = env
	log, err := os.Create(filepath.Join(root, "resident.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	cmd.Stderr = log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { cmd.Wait(); close(done) }()
	t.Cleanup(func() {
		select {
		case <-done:
			return
		default:
		}
		cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
			<-done
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var status map[string]any
	for ctx.Err() == nil {
		res, err := unixClient(socket, time.Second).Get("http://communicator.local/_comm/status")
		if err == nil {
			json.NewDecoder(res.Body).Decode(&status)
			res.Body.Close()
			if status["resident_enabled"] == true {
				break
			}
		}
		select {
		case <-done:
			output, _ := os.ReadFile(filepath.Join(root, "resident.log"))
			t.Fatalf("runtime exited: %s", output)
		case <-time.After(50 * time.Millisecond):
		}
	}
	if status["mode"] != "resident" || status["execution_enabled"] != false || status["sessions"] != float64(0) || status["https_fallback"] != true {
		t.Fatalf("bad resident state: %+v", status)
	}
	select {
	case <-oldDone:
	case <-time.After(time.Second):
		t.Fatal("source process did not exit")
	}
	if status["pid"] != float64(cmd.Process.Pid) {
		t.Fatal("resident identity does not match actual successor")
	}
	if policyReads.Load() == 0 || accountCalls.Load() != 0 {
		t.Fatalf("policy=%d account admissions=%d", policyReads.Load(), accountCalls.Load())
	}
	reads := policyReads.Load()
	time.Sleep(6 * time.Second)
	if policyReads.Load() != reads {
		t.Fatalf("idle resident polled settings: before=%d after=%d", reads, policyReads.Load())
	}

	namespace, _ := residency.Namespace(os.Getuid(), runtimeRoot)
	coord := filepath.Join("/tmp", fmt.Sprintf("cxx-%d", os.Getuid()), "owner-"+residency.Key(os.Getuid(), upstream.URL, namespace))
	defer os.RemoveAll(coord)
	journals, err := filepath.Glob(filepath.Join(coord, "adopt-*.json"))
	if err != nil || len(journals) != 1 {
		t.Fatalf("adoption journal missing: %v %v", journals, err)
	}
	journal, err := residency.ReadJournal(journals[0])
	if err != nil || journal.Phase != residency.Reopened || journal.SourcePID != old.Process.Pid || journal.TargetOwner != status["owner_instance_id"] {
		t.Fatalf("adoption not verified: %+v %v", journal, err)
	}
	probe := exec.Command(binary, "communicator", "doctor")
	probe.Env = env
	if output, err := probe.CombinedOutput(); err != nil || !strings.Contains(string(output), `"mode":"resident"`) {
		t.Fatalf("resident-only doctor: %v %s", err, output)
	}
}
