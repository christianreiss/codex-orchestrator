package communicator

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

type providerRelease struct {
	Engine     string             `json:"engine"`
	SessionID  string             `json:"session_id,omitempty"`
	NativeStop *NativeStopReceipt `json:"native_stop,omitempty"`
}

// NativeStopReceipt records an observed result, never an instruction to signal a process.
type NativeStopReceipt struct {
	SessionID         string `json:"session_id"`
	BindingGeneration int    `json:"binding_generation"`
	NativeInstanceID  string `json:"native_instance_id"`
	RequestID         string `json:"request_id"`
	Result            string `json:"result"`
}

var receiptUUID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func (v providerRelease) filename() string {
	if v.NativeStop != nil {
		return "native-" + v.NativeStop.RequestID + "-" + v.NativeStop.Result + ".json"
	}
	return v.SessionID + ".json"
}

var providerSessionID = regexp.MustCompile(`^[a-f0-9]{32}$`)

func releaseDirectory(base string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(strings.TrimRight(base, "/")))
	dir := filepath.Join(home, ".cxx", "receipts", hex.EncodeToString(digest[:16]), "provider-release")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
}
func validProviderRelease(value providerRelease) bool {
	if n := value.NativeStop; n != nil {
		return value.SessionID == "" && value.Engine == "" && receiptUUID.MatchString(n.SessionID) && receiptUUID.MatchString(n.NativeInstanceID) && receiptUUID.MatchString(n.RequestID) && n.BindingGeneration >= 0 && (n.Result == "accepted" || n.Result == "exited" || n.Result == "refused")
	}
	return providerSessionID.MatchString(value.SessionID) && (value.Engine == "codex" || value.Engine == "claude" || value.Engine == "grok")
}

// QueueProviderRelease transfers a normal-exit obligation to durable local
// storage before the wrapper exits. The communicator owns bounded retry.
// No credential material is written; the current signed host config authorizes replay.
func QueueProviderRelease(base, engine, id string) (bool, error) {
	return queueReceipt(base, providerRelease{Engine: engine, SessionID: id})
}
func QueueNativeStopReceipt(base string, value NativeStopReceipt) (bool, error) {
	return queueReceipt(base, providerRelease{NativeStop: &value})
}
func queueReceipt(base string, value providerRelease) (bool, error) {
	ep := endpointFor(base)
	if ep == nil {
		return false, nil
	}
	if !validProviderRelease(value) {
		return true, errors.New("invalid provider release identity")
	}
	dir, err := releaseDirectory(base)
	if err != nil {
		return true, err
	}
	raw, _ := json.Marshal(value)
	tmp, err := os.CreateTemp(dir, ".pending-")
	if err != nil {
		return true, err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err = tmp.Write(raw); err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return true, err
	}
	if err = os.Rename(name, filepath.Join(dir, value.filename())); err != nil {
		return true, err
	}
	if directory, e := os.Open(dir); e == nil {
		err = directory.Sync()
		directory.Close()
	} else {
		err = e
	}
	if err != nil {
		return true, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if ep.ensure(ctx) == nil {
		client := unixClient(ep.localSocket(), time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://communicator/_comm/provider-release", bytes.NewReader(raw))
		if response, e := client.Do(req); e == nil {
			response.Body.Close()
		}
	}
	return true, nil
}

func (s *server) providerReleaseHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", 405)
		return
	}
	var value providerRelease
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&value) != nil || !validProviderRelease(value) {
		http.Error(w, "identity", 400)
		return
	}
	// The caller already fsynced this exact journal. The socket is only a wakeup.
	select {
	case s.releaseWake <- struct{}{}:
	default:
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *server) providerReleaseLoop(ctx context.Context) {
	dir, err := releaseDirectory(s.configSnapshot().Orchestrator.BaseURL)
	if err != nil {
		return
	}
	watcher, watchErr := fsnotify.NewWatcher()
	if watchErr == nil {
		defer watcher.Close()
		watchErr = watcher.Add(dir)
	}
	var events <-chan fsnotify.Event
	var watchErrors <-chan error
	if watcher != nil && watchErr == nil {
		events = watcher.Events
		watchErrors = watcher.Errors
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	held := false
	defer func() {
		if held {
			s.mu.Lock()
			s.active--
			s.mu.Unlock()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.releaseWake:
		case <-events:
		case <-watchErrors:
			watchErr = errors.New("receipt watch unavailable")
			events = nil
			watchErrors = nil
		case <-timer.C:
		}
		files, readErr := os.ReadDir(dir)
		if readErr != nil {
			timer.Reset(30 * time.Second)
			continue
		}
		pending := false
		for _, file := range files {
			if strings.HasSuffix(file.Name(), ".json") {
				pending = true
				break
			}
		}
		if pending && !held {
			s.mu.Lock()
			s.active++
			s.mu.Unlock()
			held = true
		}
		failed := false
		for _, file := range files {
			if !strings.HasSuffix(file.Name(), ".json") {
				continue
			}
			path := filepath.Join(dir, file.Name())
			raw, e := os.ReadFile(path)
			if e != nil {
				failed = true
				continue
			}
			var value providerRelease
			if json.Unmarshal(raw, &value) != nil || !validProviderRelease(value) || file.Name() != value.filename() {
				failed = true
				continue
			}
			call, stop := context.WithTimeout(ctx, 10*time.Second)
			s.mu.Lock()
			connection := s.conn
			s.mu.Unlock()
			if connection == nil {
				stop()
				failed = true
				break
			}
			requestPath := "/auth/sessions/release"
			if value.NativeStop != nil {
				requestPath = "/host/native-control/receipt"
				raw, _ = json.Marshal(value.NativeStop)
			}
			response, _, e := connection.request(call, frame{Method: http.MethodPost, Path: requestPath, Headers: map[string]string{"content-type": "application/json"}, Body: raw})
			stop()
			if e != nil || response.Status < 200 || response.Status >= 300 {
				failed = true
				break
			}
			if e = os.Remove(path); e != nil && !os.IsNotExist(e) {
				failed = true
			}
		}
		if !failed && held {
			s.mu.Lock()
			s.active--
			s.mu.Unlock()
			held = false
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		if failed || watchErr != nil {
			timer.Reset(30 * time.Second)
		}
	}
}

// AcknowledgeProviderRelease retires only the exact successful release receipt.
func AcknowledgeProviderRelease(base, id string) {
	if !providerSessionID.MatchString(id) {
		return
	}
	dir, err := releaseDirectory(base)
	if err != nil {
		return
	}
	_ = os.Remove(filepath.Join(dir, id+".json"))
}
