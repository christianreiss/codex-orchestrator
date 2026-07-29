package orchestrator

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

// TestListSkillsScopesRequestToEngine pins the ?engine=codex scope on the list
// request: this binary is the Codex wrapper, and without the scope a
// dual-engine host would also fingerprint the Claude skills.
func TestListSkillsScopesRequestToEngine(t *testing.T) {
	var sawURI string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		sawURI = r.URL.RequestURI()
		_, _ = w.Write([]byte(`{"status":"ok","engine":"codex","skills":[]}`))
	})
	if _, err := c.ListSkills(context.Background()); err != nil {
		t.Fatalf("list skills: %v", err)
	}
	if sawURI != "/skills?engine=codex" {
		t.Fatalf("request URI = %q, want /skills?engine=codex", sawURI)
	}
}

// TestListSkillsEnvelopePositions pins the root-vs-`data` fallback. The handler
// returns {engine, skills:[…]}, which the standard envelope exposes both at the
// root and under `data`, so the array lives at `skills`/`data.skills` and never
// at `data` itself — decoding that object into a []Skill was the bug that kept
// the boot-screen "skills" dot from ever flipping to updated.
func TestListSkillsEnvelopePositions(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{
			name: "root wins when both positions are populated",
			body: `{"status":"ok","engine":"codex",` +
				`"skills":[{"slug":"coco","sha256":"aaa"},{"slug":"deploy","sha256":"bbb"}],` +
				`"data":{"engine":"codex","skills":[{"slug":"stale","sha256":"zzz"}]}}`,
			want: []string{"coco", "deploy"},
		},
		{
			name: "data-only envelope falls back to data.skills",
			body: `{"status":"ok","data":{"engine":"codex","skills":[{"slug":"only","sha256":"ccc"}]}}`,
			want: []string{"only"},
		},
		{
			name: "neither position populated",
			body: `{"status":"ok","engine":"codex","data":{"engine":"codex"}}`,
		},
		{
			name: "both positions present but empty",
			body: `{"status":"ok","skills":[],"data":{"skills":[]}}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(tc.body))
			})
			list, err := c.ListSkills(context.Background())
			if err != nil {
				t.Fatalf("list skills: %v", err)
			}
			if len(list) != len(tc.want) {
				t.Fatalf("got %d skills, want %d: %+v", len(list), len(tc.want), list)
			}
			for i, slug := range tc.want {
				if list[i].Slug != slug {
					t.Fatalf("skill %d slug = %q, want %q", i, list[i].Slug, slug)
				}
			}
		})
	}
}

// TestListSkillsToleratesUnknownSkillFields pins the "server side is
// authoritative" half of the Skill contract: decorate() emits more keys than we
// model, and the extras must not stop slug/sha256/display_name from decoding.
func TestListSkillsToleratesUnknownSkillFields(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","engine":"codex","skills":[{` +
			`"slug":"coco","sha256":"aaa","display_name":"Coco",` +
			`"description":"pairs with the runner","managed":true,"engine":null,` +
			`"tags":["ops"],"metadata":{"nested":{"revision":3}}}]}`))
	})
	list, err := c.ListSkills(context.Background())
	if err != nil {
		t.Fatalf("list skills: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("got %d skills, want 1: %+v", len(list), list)
	}
	if list[0].Slug != "coco" || list[0].SHA256 != "aaa" || list[0].DisplayName != "Coco" {
		t.Fatalf("unexpected skill: %+v", list[0])
	}
}

func TestListSkillsPropagatesHTTPError(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"status":"error","code":"engine_disabled","message":"engine disabled"}`))
	})
	list, err := c.ListSkills(context.Background())
	if err == nil {
		t.Fatalf("expected error, got skills %+v", list)
	}
	if list != nil {
		t.Fatalf("skills returned alongside error: %+v", list)
	}
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusForbidden || httpErr.Code != "engine_disabled" {
		t.Fatalf("unexpected error: %T %v", err, err)
	}
}
