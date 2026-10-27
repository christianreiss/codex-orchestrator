package httpguard_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	claude "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	codex "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

type personaClient interface {
	Do(context.Context, *http.Request, int) (*http.Response, error)
	JSON(context.Context, string, string, any, any, int) error
}

func eachPersona(t *testing.T, test func(*testing.T, func(string) personaClient)) {
	t.Helper()
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			test(t, func(base string) personaClient {
				if engine == "codex" {
					c, err := codex.New(codex.Options{BaseURL: base, APIKey: "test-host-key"})
					if err != nil {
						t.Fatal(err)
					}
					return c
				}
				// Grok deliberately uses the Claude orchestrator client too.
				c, err := claude.New(claude.Options{BaseURL: base, APIKey: "test-host-key"})
				if err != nil {
					t.Fatal(err)
				}
				return c
			})
		})
	}
}

func TestPersonasRejectCrossOriginCredentialAndBodyRedirect(t *testing.T) {
	eachPersona(t, func(t *testing.T, newClient func(string) personaClient) {
		var leaked atomic.Int32
		sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			leaked.Add(1)
			w.Write([]byte(`{}`))
		}))
		defer sink.Close()
		origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, sink.URL, http.StatusTemporaryRedirect)
		}))
		defer origin.Close()
		err := newClient(origin.URL).JSON(context.Background(), "POST", "/auth", map[string]string{"token": "private-body"}, nil, 0)
		if err == nil || leaked.Load() != 0 {
			t.Fatalf("redirect err=%v, foreign requests=%d", err, leaked.Load())
		}
	})
}

func TestPersonasNegativeRetriesStillMakeOneAttempt(t *testing.T) {
	eachPersona(t, func(t *testing.T, newClient func(string) personaClient) {
		var calls atomic.Int32
		origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.Write([]byte(`{}`))
		}))
		defer origin.Close()
		if err := newClient(origin.URL).JSON(context.Background(), "GET", "/status", nil, nil, -1); err != nil {
			t.Fatal(err)
		}
		if calls.Load() != 1 {
			t.Fatalf("attempts = %d", calls.Load())
		}
	})
}

func TestPersonasRefuseCredentialsOnForeignInitialRequest(t *testing.T) {
	eachPersona(t, func(t *testing.T, newClient func(string) personaClient) {
		var calls atomic.Int32
		sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
		defer sink.Close()
		req, _ := http.NewRequest("GET", sink.URL, nil)
		resp, err := newClient("https://fleet.example").Do(context.Background(), req, 0)
		if resp != nil {
			resp.Body.Close()
		}
		if err == nil || calls.Load() != 0 {
			t.Fatalf("err=%v, foreign requests=%d", err, calls.Load())
		}
	})
}

func TestPersonasRejectOversizedValidJSONPrefix(t *testing.T) {
	// The former LimitReader(cap) silently accepted this valid prefix while
	// hiding the suffix. Stream it rather than allocate 64 MiB on the server.
	eachPersona(t, func(t *testing.T, newClient func(string) personaClient) {
		origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`{}`))
			chunk := strings.Repeat(" ", 1<<20)
			for i := 0; i < 64; i++ {
				if _, err := io.WriteString(w, chunk); err != nil {
					return
				}
			}
		}))
		defer origin.Close()
		var out map[string]any
		if err := newClient(origin.URL).JSON(context.Background(), "GET", "/status", nil, &out, 0); err == nil {
			t.Fatal("oversized JSON accepted")
		}
	})
}
