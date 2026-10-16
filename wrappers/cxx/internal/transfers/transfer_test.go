package transfers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fixture(t *testing.T) (*Client, *[]byte) {
	t.Helper()
	var m upload
	data := []byte{}
	sealed := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "test" {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.Method == "POST" && r.URL.Path == "/host/transfers":
			var next upload
			_ = json.NewDecoder(r.Body).Decode(&next)
			if m.ID != "" && m != next {
				w.WriteHeader(409)
				return
			}
			m = next
		case r.Method == "PUT":
			if r.URL.Query().Get("offset") != fmt.Sprint(len(data)) {
				w.WriteHeader(409)
				return
			}
			b, _ := io.ReadAll(r.Body)
			data = append(data, b...)
		case strings.HasSuffix(r.URL.Path, "/complete"):
			sealed = true
		case strings.HasSuffix(r.URL.Path, "/content"):
			offset := 0
			if r.Header.Get("Range") != "" {
				_, _ = fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-", &offset)
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(data)-offset))
			w.Header().Set("ETag", "\""+m.SHA256+"\"")
			if offset > 0 {
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, len(data)-1, len(data)))
				w.WriteHeader(206)
			}
			_, _ = w.Write(data[offset:])
			return
		}
		status := "uploading"
		hash := ""
		if sealed {
			status = "live"
			hash = m.SHA256
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": response{Transfer: Transfer{ID: m.ID, Name: m.Name, Size: int64(len(data)), Status: status, SHA256: hash}, ChunkBytes: 4}})
	}))
	t.Cleanup(server.Close)
	return &Client{HTTP: server.Client(), BaseURL: server.URL, APIKey: "test", Engine: "codex"}, &data
}
func source(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(path, []byte{0, 255, 10, 128, 0, 5, 6, 7, 8, 9, 10}, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func TestLostUploadAckAndDownloadResume(t *testing.T) {
	c, data := fixture(t)
	path := source(t)
	ctx := context.Background()
	real := c.HTTP.Transport
	if real == nil {
		real = http.DefaultTransport
	}
	lost := false
	c.HTTP.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		resp, err := real.RoundTrip(r)
		if err == nil && r.Method == "PUT" && !lost {
			lost = true
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			return nil, fmt.Errorf("lost ACK")
		}
		return resp, err
	})
	if _, err := c.Put(ctx, path, 600, false); err == nil {
		t.Fatal("missing lost response error")
	}
	if len(*data) != 4 {
		t.Fatalf("committed offset %d", len(*data))
	}
	c.HTTP.Transport = real
	tr, err := c.Put(ctx, path, 600, true)
	if err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(path)
	if !bytes.Equal(*data, original) {
		t.Fatal("resumed upload duplicated bytes")
	}
	output := filepath.Join(t.TempDir(), "download.bin")
	interrupted := false
	c.HTTP.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		resp, err := real.RoundTrip(r)
		if err == nil && strings.HasSuffix(r.URL.Path, "/content") && !interrupted {
			interrupted = true
			resp.Body = struct {
				io.Reader
				io.Closer
			}{io.LimitReader(resp.Body, 3), resp.Body}
		}
		return resp, err
	})
	if _, err = c.Get(ctx, tr.ID, output, false, false); err == nil {
		t.Fatal("accepted truncated download")
	}
	if _, err = os.Stat(output); !os.IsNotExist(err) {
		t.Fatal("partial file published")
	}
	c.HTTP.Transport = real
	if _, err = c.Get(ctx, tr.ID, output, true, false); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(output)
	if !bytes.Equal(got, original) {
		t.Fatal("wrong resumed bytes")
	}
	if _, err = c.Get(ctx, tr.ID, output, false, false); err == nil {
		t.Fatal("overwrote existing target")
	}
}
func TestSourceChangesAndCorruptDownload(t *testing.T) {
	c, _ := fixture(t)
	path := source(t)
	real := c.HTTP.Transport
	c.HTTP.Transport = transportFunc(func(*http.Request) (*http.Response, error) { return nil, fmt.Errorf("offline") })
	_, _ = c.Put(context.Background(), path, 600, false)
	_ = os.WriteFile(path, []byte("changed"), 0600)
	if _, err := c.Put(context.Background(), path, 600, true); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("source change: %v", err)
	}
	c.HTTP.Transport = real
	path = source(t)
	tr, err := c.Put(context.Background(), path, 600, false)
	if err != nil {
		t.Fatal(err)
	}
	base := real
	if base == nil {
		base = http.DefaultTransport
	}
	c.HTTP.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		resp, err := base.RoundTrip(r)
		if err == nil && strings.HasSuffix(r.URL.Path, "/content") {
			resp.Body.Close()
			resp.Body = io.NopCloser(bytes.NewReader(bytes.Repeat([]byte{42}, int(tr.Size))))
		}
		return resp, err
	})
	output := filepath.Join(t.TempDir(), "out")
	if _, err = c.Get(context.Background(), tr.ID, output, false, false); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("corrupt download: %v", err)
	}
	if _, err = os.Stat(output); !os.IsNotExist(err) {
		t.Fatal("published corrupt file")
	}
}
func TestCommandOptions(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		o, err := parse([]string{"get", "id", "--output", "file", "--resume", "--json"}, engine)
		if err != nil || o.engine != engine || !o.resume || !o.json {
			t.Fatalf("%s: %+v %v", engine, o, err)
		}
	}
	for _, args := range [][]string{{"put"}, {"get", "id"}, {"put", "file", "--ttl-seconds", "-1"}, {"get", "id", "--output", "file", "--engine", "other"}} {
		if _, err := parse(args, ""); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

// Runs only against the disposable Fastify/MySQL fixture started by Vitest.
func TestFleetHTTPAcceptance(t *testing.T) {
	address := os.Getenv("CXX_TRANSFER_TEST_URL")
	if address == "" {
		t.Skip("no disposable fleet server")
	}
	dir := t.TempDir()
	c := &Client{HTTP: &http.Client{}, BaseURL: address, APIKey: "sender", Engine: "codex"}
	ctx := context.Background()
	for _, size := range []int64{0, 80 << 20, 3 << 30} {
		path := filepath.Join(dir, fmt.Sprintf("source-%d", size))
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if err = f.Truncate(size); err != nil {
			t.Fatal(err)
		}
		if size > 0 {
			_, _ = f.WriteAt([]byte{0, 255, 128, 10, 0, 42}, size-6)
		}
		f.Close()
		var baseline runtime.MemStats
		runtime.ReadMemStats(&baseline)
		var peak uint64 = baseline.HeapAlloc
		var lock sync.Mutex
		done := make(chan struct{})
		go func() {
			ticker := time.NewTicker(20 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-done:
					return
				case <-ticker.C:
					var m runtime.MemStats
					runtime.ReadMemStats(&m)
					lock.Lock()
					peak = max(peak, m.HeapAlloc)
					lock.Unlock()
				}
			}
		}()
		started := time.Now()
		tr, err := c.Put(ctx, path, 3600, false)
		if err != nil {
			close(done)
			t.Fatal(err)
		}
		receiver := *c
		receiver.APIKey = "receiver"
		output := path + ".download"
		if _, err = receiver.Get(ctx, tr.ID, output, false, false); err != nil {
			close(done)
			t.Fatal(err)
		}
		elapsed := time.Since(started)
		close(done)
		lock.Lock()
		growth := int64(peak) - int64(baseline.HeapAlloc)
		lock.Unlock()
		if growth > 128<<20 {
			t.Fatalf("client heap grew %d bytes", growth)
		}
		got, err := os.Open(output)
		if err != nil {
			t.Fatal(err)
		}
		h := sha256.New()
		_, _ = io.Copy(h, got)
		got.Close()
		if hex.EncodeToString(h.Sum(nil)) != tr.SHA256 {
			t.Fatal("download hash mismatch")
		}
		t.Logf("%d bytes round-trip in %s, %.1f MiB/s aggregate, client peak heap growth %.1f MiB", size, elapsed, float64(2*size)/(1<<20)/elapsed.Seconds(), float64(growth)/(1<<20))
		os.Remove(path)
		os.Remove(output)
	}
}
