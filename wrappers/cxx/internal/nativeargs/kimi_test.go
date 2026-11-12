package nativeargs

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestKimiHelpSnapshotCoversOptions(t *testing.T) {
	raw, err := os.ReadFile("testdata/kimi-help.json")
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Version  string            `json:"version"`
		Commands map[string]string `json:"commands"`
	}
	if json.Unmarshal(raw, &data) != nil || data.Version != "2.5.3" {
		t.Fatal("invalid snapshot")
	}
	for scope, table := range kimiScopedOptions {
		body := data.Commands[scope]
		for name := range table {
			if !strings.Contains(body, name) {
				t.Fatalf("%s: undocumented %s", scope, name)
			}
		}
	}
}
func TestKimiGrammarKeepsOpaqueValuesAndScopedArity(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
		end  int
	}{{[]string{"-p", "--model=forged"}, "--prompt", 1}, {[]string{"-S", "id"}, "--session", 1}, {[]string{"-S", "--auto"}, "--session", 0}, {[]string{"export", "-y"}, "--yes", 1}, {[]string{"-y"}, "--yolo", 0}, {[]string{"vis", "--host", "localhost"}, "--host", 2}, {[]string{"web", "--host", "--no-open"}, "--host", 1}} {
		at := 0
		if tc.args[0] == "export" || tc.args[0] == "vis" || tc.args[0] == "web" {
			at = 1
		}
		name, _, end := Option("kimi", tc.args, at)
		if name != tc.want || end != tc.end {
			t.Fatal(tc.args, name, end)
		}
	}
	if Value("kimi", []string{"--prompt", "--model=forged"}, "--model") != "" {
		t.Fatal("prompt parsed as model")
	}
	if cmd, _ := Command("kimi", []string{"-p", "login"}); cmd != "" {
		t.Fatal("prompt parsed as login")
	}
	if !Resumed("kimi", []string{"-c"}) || !Resumed("kimi", []string{"-S"}) {
		t.Fatal("resume grammar")
	}
	if err := ValidateAuth("kimi", []string{"login", "--region", "global"}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAuth("kimi", []string{"login", "--device-auth"}); err == nil {
		t.Fatal("accepted Grok login flag")
	}
}
