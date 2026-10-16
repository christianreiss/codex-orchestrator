package housekeeping

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRefusalNamesServerCodeAndFamily(t *testing.T) {
	cases := map[string]struct {
		status int
		body   string
		want   string
	}{
		"ip binding":   {401, `{"status":"error","message":"API key not allowed from this IP","code":"ip_mismatch","ip_family":"ipv4"}`, "HTTP 401 ip_mismatch (API key not allowed from this IP; refused over ipv4)"},
		"older server": {401, `{"status":"error","message":"API key not allowed from this IP","code":"ip_mismatch"}`, "HTTP 401 ip_mismatch (API key not allowed from this IP)"},
		"not json":     {502, `<html>bad gateway</html>`, "HTTP 502"},
		"no code":      {500, `{"status":"error"}`, "HTTP 500"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			resp := &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body))}
			if got := refusal(resp); got != tc.want {
				t.Fatalf("refusal() = %q, want %q", got, tc.want)
			}
		})
	}
}
