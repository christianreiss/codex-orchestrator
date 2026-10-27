package httpguard

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func parsed(raw string) *url.URL { u, _ := url.Parse(raw); return u }

func TestOriginAndBaseValidation(t *testing.T) {
	for _, raw := range []string{"", "fleet.example", "/relative", "ftp://fleet.example", "https://user:secret@fleet.example", "https://fleet.example/?key=value", "https://fleet.example/#token", "http://:80"} {
		if _, err := BaseURL(raw); err == nil {
			t.Errorf("accepted base %q", raw)
		}
	}
	for _, tc := range []struct {
		a, b string
		same bool
	}{
		{"https://FLEET.example/api", "https://fleet.example:443/other", true},
		{"http://fleet.example", "http://fleet.example:80", true},
		{"https://[::1]", "https://[::1]:443/path", true},
		{"https://fleet.example", "http://fleet.example", false},
		{"https://fleet.example", "https://fleet.example:444", false},
		{"https://fleet.example", "https://sub.fleet.example", false},
		{"https://fleet.example", "https://user@fleet.example", false},
	} {
		if got := SameOrigin(parsed(tc.a), parsed(tc.b)); got != tc.same {
			t.Errorf("%s / %s: %v", tc.a, tc.b, got)
		}
	}
}

func TestArtifactRedirectsNeverRestoreCredentialsOrDowngrade(t *testing.T) {
	origin, _ := http.NewRequest("GET", "https://fleet.example/cxx", nil)
	cdn, _ := http.NewRequest("GET", "https://cdn.example/cxx", nil)
	returned := origin.Clone(context.Background())
	for _, h := range []string{"X-API-Key", "Authorization", "Proxy-Authorization", "Cookie"} {
		returned.Header.Set(h, "private")
	}
	if err := ArtifactRedirect(returned, []*http.Request{origin, cdn}); err != nil {
		t.Fatal(err)
	}
	if len(returned.Header) != 0 {
		t.Fatal("credentials restored after foreign hop")
	}
	plain, _ := http.NewRequest("GET", "http://cdn.example/cxx", nil)
	if ArtifactRedirect(plain, []*http.Request{origin}) == nil {
		t.Fatal("TLS downgrade accepted")
	}
	if Redirect(cdn, []*http.Request{origin}) == nil {
		t.Fatal("authenticated CDN redirect accepted")
	}
	if Redirect(origin, make([]*http.Request, 10)) == nil {
		t.Fatal("unbounded redirects")
	}
}

func TestReadLimitRejectsHiddenSuffix(t *testing.T) {
	if _, err := ReadLimit(strings.NewReader("{}bad"), 2); err == nil {
		t.Fatal("accepted oversized prefix")
	}
	if raw, err := ReadLimit(strings.NewReader("{}"), 2); err != nil || string(raw) != "{}" {
		t.Fatalf("exact cap: %q, %v", raw, err)
	}
}

func TestDecodeRejectsTrailingDocument(t *testing.T) {
	var out map[string]any
	if err := Decode(strings.NewReader(`{} {"hidden":true}`), 64, &out); err == nil {
		t.Fatal("trailing JSON accepted")
	}
}

type trackedBody struct {
	io.Reader
	closed bool
}

func (b *trackedBody) Close() error { b.closed = true; return nil }

func TestRetryReplaysAndClosesOriginalBody(t *testing.T) {
	for _, replayable := range []bool{false, true} {
		t.Run(map[bool]string{false: "stream", true: "GetBody"}[replayable], func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				if string(raw) != "auth-body" {
					t.Errorf("replay changed body: %q", raw)
				}
				if calls.Add(1) == 1 {
					w.WriteHeader(503)
					return
				}
				w.Write([]byte(`{}`))
			}))
			defer srv.Close()
			req, _ := http.NewRequest("POST", srv.URL, strings.NewReader("auth-body"))
			original := &trackedBody{Reader: req.Body}
			req.Body = original
			if !replayable {
				req.GetBody = nil
			}
			resp, err := Do(context.Background(), srv.Client(), req, 1, func(*http.Response, []byte) error { return errors.New("server failure") })
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if calls.Load() != 2 || !original.closed {
				t.Fatalf("calls=%d, original closed=%v", calls.Load(), original.closed)
			}
		})
	}
}

func TestRetryCancellationAndTypedFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(503) }))
	defer srv.Close()
	sentinel := errors.New("typed server error")
	req, _ := http.NewRequest("GET", srv.URL, nil)
	_, err := Do(ctx, srv.Client(), req, 5, func(*http.Response, []byte) error { cancel(); return sentinel })
	if !errors.Is(err, context.Canceled) || calls.Load() != 1 {
		t.Fatalf("err=%v calls=%d", err, calls.Load())
	}
	_, err = Do(context.Background(), srv.Client(), req, 0, func(*http.Response, []byte) error { return sentinel })
	if !errors.Is(err, sentinel) {
		t.Fatalf("typed error lost: %v", err)
	}
}

func TestCancellationInterruptsReplayPreparation(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{})
	req, _ := http.NewRequest("POST", "http://fleet.example", &signaledBody{ReadCloser: reader, started: started})
	done := make(chan error, 1)
	go func() { _, err := Do(ctx, &http.Client{}, req, 1, nil); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled replay preparation remained blocked on body")
	}
}

type signaledBody struct {
	io.ReadCloser
	started chan struct{}
	once    sync.Once
}

func (b *signaledBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	return b.ReadCloser.Read(p)
}

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestZeroRetryStreamRemainsOwnedByTransport(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	req, _ := http.NewRequest("POST", "http://fleet.example", reader)
	release := make(chan struct{})
	finished := make(chan error, 1)
	client := &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		go func() {
			<-release
			raw, err := io.ReadAll(r.Body)
			r.Body.Close()
			if err == nil && string(raw) != "body" {
				err = errors.New("body changed")
			}
			finished <- err
		}()
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: http.NoBody}, nil
	})}
	resp, err := Do(context.Background(), client, req, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	close(release)
	if _, err := io.WriteString(writer, "body"); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	if err := <-finished; err != nil {
		t.Fatalf("transport body prematurely closed: %v", err)
	}
}

func TestSameOriginRedirectRetainsAuthAndBody(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path == "/first" {
			http.Redirect(w, r, "/next", http.StatusTemporaryRedirect)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-API-Key") != "private" || string(body) != "auth-body" || r.Method != "POST" {
			t.Error("same-origin redirect lost auth or body")
		}
	}))
	defer srv.Close()
	c := srv.Client()
	c.CheckRedirect = Redirect
	req, _ := http.NewRequest("POST", srv.URL+"/first", strings.NewReader("auth-body"))
	req.Header.Set("X-API-Key", "private")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if calls.Load() != 2 {
		t.Fatalf("calls=%d", calls.Load())
	}
}
