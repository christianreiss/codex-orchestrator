package communicator

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMCPFailuresPreserveUnknownWriteOutcomes(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  int
		body    string
		code    string
		unknown bool
	}{
		{"lost write reply", 409, `{"error":{"code":"communicator_outcome_unknown","message":"secret upstream body"}}`, "communicator_outcome_unknown", true},
		{"local transport loss", 0, "", "communicator_outcome_unknown", true},
		{"incomplete successful reply", 200, "partial secret", "communicator_outcome_unknown", true},
		{"oversized completed reply", 502, `{"code":"communicator_response_too_large"}`, "communicator_response_too_large", true},
		{"known unavailable", 503, `{"error":{"code":"communicator_unavailable"}}`, "communicator_unavailable", false},
		{"host mismatch", 401, `{"code":"communicator_mcp_host_mismatch"}`, "communicator_mcp_host_mismatch", false},
		{"untrusted message", 403, `{"code":"secret upstream body"}`, "communicator_request_failed", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := mcpFailure(json.RawMessage(`"original-request"`), test.status, []byte(test.body))
			var result struct {
				ID    string
				Error struct {
					Code    int
					Message string
					Data    struct {
						Code    string
						Status  int  `json:"http_status"`
						Unknown bool `json:"outcome_unknown"`
					}
				}
			}
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			if result.ID != "original-request" || result.Error.Code != -32000 || result.Error.Data.Code != test.code || result.Error.Data.Status != test.status || result.Error.Data.Unknown != test.unknown {
				t.Fatalf("lost failure contract: %s", raw)
			}
			if test.unknown && !strings.Contains(result.Error.Message, "before retrying") {
				t.Fatal("ambiguous write invited replay")
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
