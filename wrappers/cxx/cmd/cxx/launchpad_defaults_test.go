package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/launchpad"
)

func TestFleetDefaultClientUsesSelectedEngineConfigAndEnvelope(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok", "kimi"} {
		t.Run(engine, func(t *testing.T) {
			posts := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/host/model-defaults/"+engine || r.Header.Get("X-API-Key") != engine+"-key" {
					t.Errorf("wrong engine credential or endpoint: %s", r.URL.Path)
				}
				if r.Method == http.MethodPost {
					posts++
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if len(body) != 2 || body["model"] != "selected-model" {
						t.Errorf("wrong payload: %+v", body)
					}
					if engine == "kimi" && body["reasoning_effort"] != nil {
						t.Error("missing null effort")
					}
				}
				fmt.Fprintf(w, `{"status":"ok","data":{"engine":%q,"model":"selected-model","reasoning_effort":null}}`, engine)
			}))
			defer srv.Close()
			loads := 0
			client := fleetDefaultsClient{load: func(got string) (*config.Config, error) {
				loads++
				if got != engine {
					t.Errorf("wrong config: %s", got)
				}
				return &config.Config{Orchestrator: config.Orchestrator{BaseURL: srv.URL, APIKey: engine + "-key"}}, nil
			}}
			value, err := client.Get(context.Background(), engine)
			if err != nil || value.Model != "selected-model" || value.Engine != engine {
				t.Fatalf("GET: %+v %v", value, err)
			}
			_, err = client.Set(context.Background(), launchpad.Selection{Engine: engine, Model: "selected-model"})
			if err != nil || loads != 2 || posts != 1 {
				t.Fatalf("POST: %v loads=%d posts=%d", err, loads, posts)
			}
		})
	}
}

func TestFleetDefaultClientNeverRetriesPostAndSanitizesErrors(t *testing.T) {
	for _, status := range []int{404, 405, 401, 403, 409, 422, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(status)
				fmt.Fprint(w, `{"code":"test_refusal","message":"private response details"}`)
			}))
			defer srv.Close()
			c := fleetDefaultsClient{load: func(string) (*config.Config, error) {
				return &config.Config{Orchestrator: config.Orchestrator{BaseURL: srv.URL, APIKey: "never-print-key"}}, nil
			}}
			_, err := c.Set(context.Background(), launchpad.Selection{Engine: "codex", Model: "selected", Effort: "high"})
			if err == nil || calls != 1 {
				t.Fatalf("unexpected retry: calls=%d err=%v", calls, err)
			}
			if status == 404 || status == 405 {
				if !errors.Is(err, launchpad.ErrDefaultsUnavailable) {
					t.Fatal(err)
				}
			}
			if status == 409 || status == 422 {
				if !errors.Is(err, launchpad.ErrDefaultsRejected) {
					t.Fatal(err)
				}
			}
			if (status == 401 || status == 403) && errors.Is(err, launchpad.ErrDefaultsRejected) {
				t.Fatal("response authority denial incorrectly proves the write failed")
			}
			if strings.Contains(err.Error(), "private response details") {
				t.Fatal("raw response leaked")
			}
		})
	}
}

func TestFleetDefaultClientRefusesForeignRedirectAndBadReply(t *testing.T) {
	leaked := 0
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked++ }))
	defer foreign.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, foreign.URL, http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	c := fleetDefaultsClient{load: func(string) (*config.Config, error) {
		return &config.Config{Orchestrator: config.Orchestrator{BaseURL: srv.URL, APIKey: "test-key"}}, nil
	}}
	if _, err := c.Get(context.Background(), "codex"); err == nil || leaked != 0 {
		t.Fatalf("foreign redirect accepted: %v", err)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"engine":"claude","model":"other-engine"}`)
	}))
	defer bad.Close()
	c.load = func(string) (*config.Config, error) {
		return &config.Config{Orchestrator: config.Orchestrator{BaseURL: bad.URL}}, nil
	}
	if _, err := c.Get(context.Background(), "codex"); err == nil {
		t.Fatal("wrong engine reply accepted")
	}
}

func TestFleetDefaultPostRefusesSameOriginRedirectReplay(t *testing.T) {
	for _, status := range []int{307, 308} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				http.Redirect(w, r, "/repeat", status)
			}))
			defer srv.Close()
			c := fleetDefaultsClient{load: func(string) (*config.Config, error) {
				return &config.Config{Orchestrator: config.Orchestrator{BaseURL: srv.URL}}, nil
			}}
			_, err := c.Set(context.Background(), launchpad.Selection{Engine: "codex", Model: "selected", Effort: "high"})
			if err == nil || calls != 1 {
				t.Fatalf("POST redirect replayed: calls=%d err=%v", calls, err)
			}
		})
	}
}
