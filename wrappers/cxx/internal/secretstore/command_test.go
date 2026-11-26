package secretstore

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const pem = "-----BEGIN PRIVATE KEY-----\nMIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDBtopsecretmaterial\n-----END PRIVATE KEY-----\n"

type call struct {
	path, apiKey, bearer, engine, tool string
	arguments                          map[string]any
}

// serve answers secret_store like the orchestrator does and records each call.
func serve(t *testing.T, reply func(args map[string]any) (int, string)) (*httptest.Server, *[]call) {
	t.Helper()
	calls := &[]call{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID     string `json:"id"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		*calls = append(*calls, call{r.URL.Path, r.Header.Get("X-API-Key"), r.Header.Get("Authorization"), r.Header.Get("X-Engine"), body.Params.Name, body.Params.Arguments})
		status, text := reply(body.Params.Arguments)
		w.WriteHeader(status)
		io.WriteString(w, text)
	}))
	t.Cleanup(server.Close)
	return server, calls
}

func receipt(slug, name, status string) string {
	inner, _ := json.Marshal(map[string]any{"secret": map[string]any{"slug": slug, "name": name, "description": nil, "tags": []string{}, "last_rotated_at": "2026-11-26T14:00:00Z", "owned_by_you": true}, "status": status})
	outer, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "secret-store", "result": map[string]any{"isError": false, "content": []any{map[string]any{"type": "text", "text": string(inner)}}}})
	return string(outer)
}

func TestStoreSendsExactFileBytesAcrossEngines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "k.pem")
	if err := os.WriteFile(path, []byte(pem), 0600); err != nil {
		t.Fatal(err)
	}
	for _, engine := range []string{"codex", "claude", "grok", "kimi"} {
		t.Run(engine, func(t *testing.T) {
			server, calls := serve(t, func(map[string]any) (int, string) { return 200, receipt("ca-key", "CA key", "created") })
			o, err := parse([]string{"store", "ca-key", "--file", path, "--name", "CA key", "--description", "Fleet CA signing key", "--tag", "ca", "--tag", "pki"}, engine)
			if err != nil {
				t.Fatal(err)
			}
			value, err := readValue(o, strings.NewReader("unused"))
			if err != nil {
				t.Fatal(err)
			}
			got, err := store(context.Background(), server.Client(), server.URL, "test", o, value)
			if err != nil {
				t.Fatal(err)
			}
			c := (*calls)[0]
			if len(*calls) != 1 || c.path != "/mcp" || c.apiKey != "test" || c.bearer != "Bearer test" || c.engine != engine || c.tool != "secret_store" {
				t.Fatalf("calls=%+v", *calls)
			}
			// Byte for byte, including the trailing newline.
			if c.arguments["value"] != pem || c.arguments["slug"] != "ca-key" || c.arguments["name"] != "CA key" || c.arguments["description"] != "Fleet CA signing key" {
				t.Fatalf("arguments=%v", c.arguments)
			}
			if tags, _ := json.Marshal(c.arguments["tags"]); string(tags) != `["ca","pki"]` {
				t.Fatalf("tags=%s", tags)
			}
			if got != (Result{Slug: "ca-key", Name: "CA key", Status: "created", ValueBytes: len(pem), OwnedByYou: true}) {
				t.Fatalf("result=%+v", got)
			}
		})
	}
}

func TestStoreOmitsUnsetFieldsSoRotationKeepsThem(t *testing.T) {
	server, calls := serve(t, func(map[string]any) (int, string) { return 200, receipt("api-token", "Kept", "rotated") })
	o, err := parse([]string{"store", "api-token", "--stdin"}, "claude")
	if err != nil {
		t.Fatal(err)
	}
	value, err := readValue(o, strings.NewReader("tok_123"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store(context.Background(), server.Client(), server.URL, "test", o, value); err != nil {
		t.Fatal(err)
	}
	args := (*calls)[0].arguments
	for _, key := range []string{"name", "description", "tags"} {
		if _, ok := args[key]; ok {
			t.Fatalf("%s sent although unset: %v", key, args)
		}
	}
	if args["value"] != "tok_123" {
		t.Fatalf("value=%v", args["value"])
	}
}

func TestReadValueRefusesBeforeAnyNetworkUse(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, raw []byte) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	cases := map[string]struct {
		o    options
		in   string
		want string
	}{
		"empty file":     {options{file: write("empty", nil)}, "", "empty"},
		"empty stdin":    {options{stdin: true}, "", "empty"},
		"oversized":      {options{file: write("big", bytes.Repeat([]byte("a"), maxBytes+1))}, "", "1 MiB"},
		"binary DER":     {options{file: write("k.der", []byte{0x30, 0x82, 0xff, 0xfe, 0x00})}, "", "not valid UTF-8"},
		"directory":      {options{file: dir}, "", "regular file"},
		"missing file":   {options{file: filepath.Join(dir, "absent")}, "", "no such file"},
		"binary on pipe": {options{stdin: true}, "\xff\xfe", "not valid UTF-8"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := readValue(tc.o, strings.NewReader(tc.in)); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error=%v, want %q", err, tc.want)
			}
		})
	}
	if raw, err := readValue(options{file: write("exact", bytes.Repeat([]byte("a"), maxBytes))}, nil); err != nil || len(raw) != maxBytes {
		t.Fatalf("a value of exactly 1 MiB must pass: len=%d err=%v", len(raw), err)
	}
}

// The point of the command: nothing it prints may contain the value, on any path.
func TestNoOutputEverContainsTheValue(t *testing.T) {
	const secret = "s3cr3t-value-that-must-not-leak"
	echo := func(args map[string]any) string { return "rejected " + args["value"].(string) }
	replies := map[string]func(args map[string]any) (int, string){
		"success":    func(map[string]any) (int, string) { return 200, receipt("demo", "demo", "created") },
		"http error": func(args map[string]any) (int, string) { return 503, echo(args) },
		"rpc error": func(args map[string]any) (int, string) {
			m, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "secret-store", "error": map[string]any{"code": -32000, "message": echo(args)}})
			return 200, string(m)
		},
		"tool isError": func(args map[string]any) (int, string) {
			inner, _ := json.Marshal(map[string]any{"error": map[string]any{"code": "secret_not_owned", "message": echo(args)}})
			m, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "secret-store", "result": map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": string(inner)}}}})
			return 200, string(m)
		},
		"bad receipt": func(args map[string]any) (int, string) {
			return 200, `{"jsonrpc":"2.0","id":"secret-store","result":{"content":[{"type":"text","text":"` + echo(args) + `"}]}}`
		},
		"wrong id": func(map[string]any) (int, string) { return 200, `{"jsonrpc":"2.0","id":"other","result":{}}` },
	}
	for name, reply := range replies {
		t.Run(name, func(t *testing.T) {
			server, _ := serve(t, reply)
			o, err := parse([]string{"store", "demo", "--stdin"}, "codex")
			if err != nil {
				t.Fatal(err)
			}
			got, err := store(context.Background(), server.Client(), server.URL, "test", o, []byte(secret))
			printed, _ := json.Marshal(got)
			text := string(printed)
			if err != nil {
				text += err.Error()
				if !strings.Contains(err.Error(), "secret store") {
					t.Fatalf("error does not say what failed: %v", err)
				}
			}
			if strings.Contains(text, secret) {
				t.Fatalf("value leaked: %s", text)
			}
			if name == "success" && (err != nil || got.Status != "created") {
				t.Fatalf("result=%+v err=%v", got, err)
			}
			if name != "success" && err == nil {
				t.Fatalf("%s accepted: %+v", name, got)
			}
		})
	}
}

func TestUncertainOutcomesSayARetryIsSafe(t *testing.T) {
	server, _ := serve(t, func(map[string]any) (int, string) { return 502, "" })
	o, _ := parse([]string{"store", "demo", "--stdin"}, "codex")
	if _, err := store(context.Background(), server.Client(), server.URL, "test", o, []byte("v")); err == nil || !strings.Contains(err.Error(), "same command again is safe") {
		t.Fatalf("error=%v", err)
	}
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	if _, err := store(context.Background(), closed.Client(), closed.URL, "test", o, []byte("value-123")); err == nil || !strings.Contains(err.Error(), "unconfirmed") || strings.Contains(err.Error(), "value-123") {
		t.Fatalf("error=%v", err)
	}
}

func TestParseRequiresExactlyOneSource(t *testing.T) {
	for _, args := range [][]string{
		{"store", "demo"},
		{"store", "demo", "--file", "a", "--stdin"},
		{"store", "--stdin"},
		{"store"},
		{"get", "demo", "--stdin"},
		{"store", "demo", "--stdin", "--value", "x"},
		{"store", "demo", "--file"},
		{"store", "demo", "--stdin", "--engine", "gemini"},
	} {
		if _, err := parse(args, "codex"); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "kimi")
	if o, err := parse([]string{"store", "demo", "--stdin", "--json"}, ""); err != nil || o.engine != "kimi" || !o.json {
		t.Fatalf("options=%+v err=%v", o, err)
	}
}

func TestCommandHelpAndUsageErrors(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := Command([]string{"--help"}, "", nil, &out, &errOut); code != 0 || !strings.Contains(out.String(), "secret store SLUG") {
		t.Fatalf("code=%d help=%s", code, out.String())
	}
	out.Reset()
	if code := Command([]string{"store", "demo"}, "", nil, &out, &errOut); code != 2 || out.Len() != 0 {
		t.Fatalf("code=%d stdout=%s", code, out.String())
	}
	// A read failure stops before configuration or network and never echoes input.
	errOut.Reset()
	if code := Command([]string{"store", "demo", "--stdin"}, "codex", strings.NewReader("\xffzz-input-zz"), &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "UTF-8") || strings.Contains(errOut.String(), "zz-input-zz") {
		t.Fatalf("code=%d stderr=%s", code, errOut.String())
	}
}
