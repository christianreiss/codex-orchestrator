package kimi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestManifestInstallVerifiesBeforePublish(t *testing.T) {
	for _, bad := range []bool{false, true} {
		t.Run(fmt.Sprint(bad), func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("KIMI_CODE_HOME", filepath.Join(t.TempDir(), "native"))
			binary := []byte("#!/bin/sh\nprintf 'kimi 2.5.3\\n'\n")
			sum := sha256.Sum256(binary)
			pkg, err := PlatformPackage(runtime.GOOS, runtime.GOARCH)
			if err != nil {
				t.Skip(err)
			}
			checksum := hex.EncodeToString(sum[:])
			if bad {
				checksum = strings.Repeat("0", 64)
			}
			client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
				body := string(binary)
				switch r.URL.Path {
				case "/kimi-code/binaries/2.5.3/manifest.json":
					body = fmt.Sprintf(`{"platforms":{%q:{"filename":"kimi-test","checksum":%q}}}`, pkg, checksum)
				case "/kimi-code/binaries/2.5.3/kimi-test":
				default:
					t.Fatalf("unexpected URL %s", r.URL)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			path, err := installWithClient(context.Background(), "2.5.3", client)
			state, _ := StateDir()
			root, _ := StoreDir()
			if bad {
				if err == nil {
					t.Fatal("accepted tampered binary")
				}
				if _, err := os.Stat(filepath.Join(state, "kimi-bin")); !os.IsNotExist(err) {
					t.Fatal("published failed install")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if path != filepath.Join(root, "2.5.3", "kimi") {
				t.Fatal(path)
			}
			if version, err := ProbeVersion(context.Background(), path); err != nil || version != "2.5.3" {
				t.Fatal(version, err)
			}
			if err := Prune(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestKimiVersionFloorAndPlatform(t *testing.T) {
	for _, v := range []string{"2.5.3", "2.6.0", "3.0.0"} {
		if !SupportedVersion(v) {
			t.Fatal(v)
		}
	}
	for _, v := range []string{"", "2.5.2", "2.5.3-beta", "../2.5.3"} {
		if SupportedVersion(v) {
			t.Fatal(v)
		}
	}
	if _, err := PlatformPackage("windows", "amd64"); err == nil {
		t.Fatal("unsupported platform")
	}
	if CoerceVersionToMinimum("2.4.0") != PinnedVersion {
		t.Fatal("old pin not healed")
	}
}

func TestRuntimeEnvironmentRejectsAmbientProviderOverrides(t *testing.T) {
	r := &Runtime{Home: "/private/home", BaseHome: "/durable", Socket: "/private/readiness"}
	for _, item := range r.Environment([]string{"KIMI_API_KEY=ambient", "KIMI_MODEL_NAME=ambient-model", "KIMI_MODEL_API_KEY=ambient-key", "KEEP_ME=yes"}) {
		if strings.Contains(item, "ambient") {
			t.Fatal(item)
		}
	}
}
