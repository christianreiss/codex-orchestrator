package orchestrator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// The envelope duplicates lane fields at the root and under `data` depending on
// the server build, so GetLane has to read both positions and still answer with
// the server's own default when a build sends neither.
func TestGetLaneFallbackChain(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		want    string
		wantErr bool
	}{
		{
			name: "root wins over data copy",
			body: `{"status":"ok","effective_lane":"spark","data":{"effective_lane":"normal"}}`,
			want: "spark",
		},
		{
			name: "data copy used when root is empty",
			body: `{"status":"ok","effective_lane":"","data":{"effective_lane":"spark"}}`,
			want: "spark",
		},
		{
			name: "data copy used when root is absent",
			body: `{"status":"ok","data":{"lane_preference":"spark","effective_lane":"spark"}}`,
			want: "spark",
		},
		{
			name: "empty envelope defaults to normal",
			body: `{}`,
			want: "normal",
		},
		{
			name: "lane_preference alone does not set the effective lane",
			body: `{"status":"ok","lane_preference":"spark","data":{"lane_preference":"spark"}}`,
			want: "normal",
		},
		{
			// A zero-byte body is a decode failure, not the "normal" default.
			name:    "no body at all is an error",
			body:    "",
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotMethod, gotPath string
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				gotMethod = r.Method
				gotPath = r.URL.Path
				_, _ = io.WriteString(w, tc.body)
			})
			got, err := c.GetLane(context.Background())
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got lane %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("GetLane: %v", err)
			}
			if got != tc.want {
				t.Errorf("lane=%q want %q", got, tc.want)
			}
			if gotMethod != http.MethodGet {
				t.Errorf("method=%s want GET", gotMethod)
			}
			if gotPath != "/host/lane" {
				t.Errorf("path=%s", gotPath)
			}
		})
	}
}

func TestSetLaneNormalizesLane(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "trims and lowercases", in: " SPARK ", want: `{"lane":"spark"}`},
		{name: "mixed case normal", in: "Normal", want: `{"lane":"normal"}`},
		{name: "already canonical", in: "spark", want: `{"lane":"spark"}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotMethod, gotPath, gotBody string
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				gotMethod = r.Method
				gotPath = r.URL.Path
				buf, _ := io.ReadAll(r.Body)
				gotBody = string(buf)
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "effective_lane": "spark"})
			})
			if err := c.SetLane(context.Background(), tc.in); err != nil {
				t.Fatalf("SetLane(%q): %v", tc.in, err)
			}
			if gotMethod != http.MethodPost {
				t.Errorf("method=%s want POST", gotMethod)
			}
			if gotPath != "/host/lane" {
				t.Errorf("path=%s", gotPath)
			}
			if gotBody != tc.want {
				t.Errorf("body=%s want %s", gotBody, tc.want)
			}
		})
	}
}

// SetLane is the only place an unknown lane is rejected before it reaches the
// API, so a bad value must never leave the wrapper.
func TestSetLaneRejectsUnknownLaneWithoutRequest(t *testing.T) {
	for _, lane := range []string{"turbo", "", "   ", "sparky", "spark spark"} {
		t.Run(lane, func(t *testing.T) {
			calls := 0
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				_, _ = io.WriteString(w, `{}`)
			})
			err := c.SetLane(context.Background(), lane)
			if err == nil {
				t.Fatalf("SetLane(%q) accepted an invalid lane", lane)
			}
			if !strings.Contains(err.Error(), "normal|spark") {
				t.Errorf("error must name the valid lanes: %v", err)
			}
			if calls != 0 {
				t.Errorf("issued %d request(s) for an invalid lane", calls)
			}
		})
	}
}

// The API distinguishes an explicit JSON null (clear the per-host preference)
// from the string "normal" (pin the host to the normal lane), so ClearLane must
// post null.
func TestClearLanePostsJSONNull(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody []byte
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "effective_lane": "normal"})
	})
	if err := c.ClearLane(context.Background()); err != nil {
		t.Fatalf("ClearLane: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method=%s want POST", gotMethod)
	}
	if gotPath != "/host/lane" {
		t.Errorf("path=%s", gotPath)
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(gotBody, &fields); err != nil {
		t.Fatalf("decode body %s: %v", gotBody, err)
	}
	raw, ok := fields["lane"]
	if !ok {
		t.Fatalf("body omitted the lane key: %s", gotBody)
	}
	if string(raw) != "null" {
		t.Errorf("lane=%s want null (a lane string would not clear the preference)", raw)
	}
}
