package claude

import (
	"os"
	"runtime"
	"testing"
)

func writeScript(t *testing.T, path, body string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		body = "@echo off\r\n" + body
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}
