package communicator

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// An operator who sees {"running":false,"socket":""} cannot tell a stopped owner from a
// runtime directory the wrapper refused to use. The refusal is the answer.
func TestStatusExplainsAnUnusableSocket(t *testing.T) {
	base := "https://status-refusal.example"
	registry.Store(base, &endpoint{base: base, setupErr: errors.New("runtime directory /run/user/0 is not private to uid 1000")})
	t.Cleanup(func() { registry.Delete(base) })
	for _, arg := range []string{"status", "doctor"} {
		var out, errOut bytes.Buffer
		code := Command([]string{arg}, strings.NewReader(""), &out, &errOut, "test")
		var line map[string]any
		found := false
		for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
			if json.Unmarshal([]byte(l), &line) == nil && line["server"] == base {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s: no line for the refused endpoint in %q", arg, out.String())
		}
		if line["running"] != false || !strings.Contains(line["error"].(string), "not private to uid 1000") {
			t.Fatalf("%s: the refusal reason is missing: %v", arg, line)
		}
		if arg == "doctor" && code != 1 {
			t.Fatalf("doctor must fail for an unusable socket, exit %d", code)
		}
		if arg == "status" && code != 0 {
			t.Fatalf("status reports, it does not fail: exit %d", code)
		}
	}
}

func TestMCPFailuresPreserveUnknownWriteOutcomes(t *testing.T) {
	for _, test := range []struct {
		name      string
		status    int
		body      string
		code      string
		unknown   bool
		retryable bool
	}{
		{"lost write reply", 409, `{"error":{"code":"communicator_outcome_unknown","message":"secret upstream body"}}`, "communicator_outcome_unknown", true, false},
		{"local transport loss", 0, "", "communicator_outcome_unknown", true, false},
		{"incomplete successful reply", 200, "partial secret", "communicator_outcome_unknown", true, false},
		{"oversized completed reply", 502, `{"code":"communicator_response_too_large"}`, "communicator_response_too_large", true, false},
		{"known unavailable", 503, `{"error":{"code":"communicator_unavailable"}}`, "communicator_unavailable", false, true},
		{"unavailable code on an upstream 500", 500, `{"error":{"code":"communicator_unavailable"}}`, "communicator_unavailable", false, false},
		{"host mismatch", 401, `{"code":"communicator_mcp_host_mismatch"}`, "communicator_mcp_host_mismatch", false, false},
		{"untrusted message", 403, `{"code":"secret upstream body"}`, "communicator_request_failed", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := mcpFailure(json.RawMessage(`"original-request"`), test.status, []byte(test.body))
			var result struct {
				ID    string
				Error struct {
					Code    int
					Message string
					Data    struct {
						Code      string
						Status    int  `json:"http_status"`
						Unknown   bool `json:"outcome_unknown"`
						Retryable bool `json:"retryable"`
					}
				}
			}
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			if result.ID != "original-request" || result.Error.Code != -32000 || result.Error.Data.Code != test.code || result.Error.Data.Status != test.status || result.Error.Data.Unknown != test.unknown || result.Error.Data.Retryable != test.retryable {
				t.Fatalf("lost failure contract: %s", raw)
			}
			if test.unknown && !strings.Contains(result.Error.Message, "before retrying") {
				t.Fatal("ambiguous write invited replay")
			}
			if test.retryable != strings.Contains(result.Error.Message, "not sent") {
				t.Fatalf("retry hint does not match the definitive not-sent case: %s", raw)
			}
			if strings.Contains(string(raw), "secret") {
				t.Fatalf("upstream body exposed: %s", raw)
			}
		})
	}
}

func TestMCPResponsesRequireOriginalCorrelation(t *testing.T) {
	for _, body := range []string{`{}`, `{"jsonrpc":"2.0","id":2,"result":{}}`, `{"jsonrpc":"2.0","id":1}`, `not JSON`} {
		if mcpResponseValid(json.RawMessage(`1`), []byte(body)) {
			t.Fatalf("accepted incomplete/misrouted response: %s", body)
		}
	}
	for _, body := range []string{`{"jsonrpc":"2.0","id":1,"result":null}`, `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"unknown method"}}`} {
		if !mcpResponseValid(json.RawMessage(`1`), []byte(body)) {
			t.Fatalf("rejected valid MCP response: %s", body)
		}
	}
}

func TestMCPResponsesCannotReportBothResultAndError(t *testing.T) {
	for _, body := range []string{
		`{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-32603,"message":"failed"}}`,
		`{"jsonrpc":"2.0","id":1,"result":null,"error":{"code":-32603,"message":"failed"}}`,
		`{"jsonrpc":"2.0","id":1,"result":{},"error":null}`,
	} {
		if mcpResponseValid(json.RawMessage(`1`), []byte(body)) {
			t.Fatalf("accepted contradictory MCP response: %s", body)
		}
	}
}

func TestMCPCorrelationUsesJSONIDValues(t *testing.T) {
	for _, test := range []struct {
		request, reply string
		equal          bool
	}{
		{`"\u0061"`, `"a"`, true},
		{`"\u003ctest\u003e"`, `"<test>"`, true},
		{`1.0`, `1`, true},
		{`1e1`, `10`, true},
		{`-0`, `0`, true},
		{`0.0030`, `3e-3`, true},
		{`9007199254740993`, `9007199254740992`, false},
		{`"1"`, `1`, false},
		{`"a"`, `"b"`, false},
	} {
		body := []byte(`{"jsonrpc":"2.0","id":` + test.reply + `,"result":null}`)
		if got := mcpResponseValid(json.RawMessage(test.request), body); got != test.equal {
			t.Errorf("request ID %s, reply ID %s: matched=%v, want %v", test.request, test.reply, got, test.equal)
		}
	}
}

func TestMCPErrorEnvelopeRequiresIntegerCodeAndStringMessage(t *testing.T) {
	for _, invalid := range []string{`null`, `[]`, `{}`, `{"code":-32603}`, `{"message":"failed"}`, `{"code":"-32603","message":"failed"}`, `{"code":1.5,"message":"failed"}`, `{"code":-32603,"message":null}`, `{"code":null,"message":"failed"}`} {
		body := []byte(`{"jsonrpc":"2.0","id":1,"error":` + invalid + `}`)
		if mcpResponseValid(json.RawMessage(`1`), body) {
			t.Errorf("accepted malformed error envelope: %s", body)
		}
	}
	for _, valid := range []string{`{"code":0,"message":""}`, `{"code":-32603,"message":"failed","data":null}`} {
		body := []byte(`{"jsonrpc":"2.0","id":1,"error":` + valid + `}`)
		if !mcpResponseValid(json.RawMessage(`1`), body) {
			t.Errorf("rejected valid error: %s", body)
		}
	}
}
