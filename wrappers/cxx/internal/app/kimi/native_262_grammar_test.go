package kimi

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKimi262UnintegratedLifecyclesRefuseBeforeConfig(t *testing.T) {
	t.Setenv("CKX_CONFIG_PATH", t.TempDir()+"/missing.json")
	for _, args := range [][]string{
		{"exec-server"}, {"exec-server", "--listen=stdio"},
		{"__update_download", "2.6.2", "--channel", "stable"},
		{"__plugin_run_node", "/nonexistent/entry.js"},
		{"--environment", "remote"}, {"--environment-cwd", "/remote/work"},
	} {
		var out, errout bytes.Buffer
		if code := RunNative(args, &out, &errout); code != 2 || !strings.Contains(errout.String(), "separate managed auth/session lifecycle") {
			t.Fatalf("%q: code=%d out=%q err=%q", args, code, out.String(), errout.String())
		}
	}
}

func TestKimi262HelpAndOpaqueCatalogValues(t *testing.T) {
	cli := filepath.Join(t.TempDir(), "kimi")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'native-help-pass\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CKX_KIMI_BIN", cli)
	t.Setenv("CKX_CONFIG_PATH", t.TempDir()+"/missing.json")
	for _, args := range [][]string{{"exec-server", "--help"}, {"__update_download", "--help"}, {"--environment", "remote", "--help"}} {
		if !isHelpPassthrough(args) {
			t.Fatalf("help was refused: %q", args)
		}
		var out, errout bytes.Buffer
		if code := RunNative(args, &out, &errout); code != 0 || out.String() != "native-help-pass\n" || errout.Len() != 0 {
			t.Fatalf("%q reached configuration/admission: code=%d out=%q err=%q", args, code, out.String(), errout.String())
		}
	}
	for _, args := range [][]string{
		{"provider", "catalog", "list", "--url", "--help"},
		{"provider", "catalog", "add", "--api-key", "--version"},
		{"provider", "catalog", "add", "--default-model", "login"},
	} {
		if isHelpPassthrough(args) || nativeAnyFlag(args, "--version") || nativeCommand(args) != "provider" {
			t.Fatalf("catalog data changed help/version/auth dispatch: %q", args)
		}
	}
}
