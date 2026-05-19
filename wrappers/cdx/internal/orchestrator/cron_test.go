package orchestrator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestCronCheckSendsEngineAndVersions(t *testing.T) {
	var gotMethod, gotPath, gotBody string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		buf, _ := io.ReadAll(r.Body)
		gotBody = string(buf)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"action": "update",
			"wrapper": map[string]any{
				"action":         "update",
				"target_version": "2.5.0",
				"sha256":         "deadbeef",
				"url":            "/wrapper/v2/download/cdx-linux-amd64",
			},
			"target_version": "0.50.0",
			"tag":            "rust-v0.50.0",
			"enforce_exact":  true,
		})
	})
	resp, err := c.CronCheck(context.Background(), CronCheckRequest{
		Engine:         "codex",
		ClientVersion:  "0.49.0",
		WrapperVersion: "2.4.0",
	})
	if err != nil {
		t.Fatalf("CronCheck: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method=%s want POST", gotMethod)
	}
	if gotPath != "/cron/check" {
		t.Errorf("path=%s", gotPath)
	}
	if !strings.Contains(gotBody, `"engine":"codex"`) {
		t.Errorf("missing engine in body: %s", gotBody)
	}
	if !strings.Contains(gotBody, `"client_version":"0.49.0"`) {
		t.Errorf("missing client_version: %s", gotBody)
	}
	if !strings.Contains(gotBody, `"wrapper_version":"2.4.0"`) {
		t.Errorf("missing wrapper_version: %s", gotBody)
	}
	if resp.Action != "update" {
		t.Errorf("action=%s", resp.Action)
	}
	if resp.Wrapper == nil || resp.Wrapper.Action != "update" {
		t.Fatalf("wrapper block missing: %+v", resp.Wrapper)
	}
	if resp.Wrapper.TargetVersion != "2.5.0" {
		t.Errorf("wrapper target_version=%s", resp.Wrapper.TargetVersion)
	}
	if resp.Wrapper.SHA256 != "deadbeef" {
		t.Errorf("wrapper sha=%s", resp.Wrapper.SHA256)
	}
	if resp.Wrapper.URL != "/wrapper/v2/download/cdx-linux-amd64" {
		t.Errorf("wrapper url=%s", resp.Wrapper.URL)
	}
	if resp.TargetVersion != "0.50.0" {
		t.Errorf("target_version=%s", resp.TargetVersion)
	}
	if !resp.EnforceExact {
		t.Errorf("enforce_exact lost")
	}
}

func TestCronCheckDefaultsEngine(t *testing.T) {
	var body string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		buf, _ := io.ReadAll(r.Body)
		body = string(buf)
		_ = json.NewEncoder(w).Encode(map[string]any{"action": "no_update"})
	})
	if _, err := c.CronCheck(context.Background(), CronCheckRequest{}); err != nil {
		t.Fatalf("CronCheck: %v", err)
	}
	if !strings.Contains(body, `"engine":"codex"`) {
		t.Errorf("default engine missing: %s", body)
	}
}

func TestCronReportRoundTrip(t *testing.T) {
	var gotPath, gotBody string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		buf, _ := io.ReadAll(r.Body)
		gotBody = string(buf)
		_, _ = w.Write([]byte(`{"recorded":true}`))
	})
	err := c.CronReport(context.Background(), CronReportRequest{
		Engine:         "codex",
		ClientVersion:  "0.50.0",
		WrapperVersion: "2.5.0",
	})
	if err != nil {
		t.Fatalf("CronReport: %v", err)
	}
	if gotPath != "/cron/report" {
		t.Errorf("path=%s", gotPath)
	}
	if !strings.Contains(gotBody, `"client_version":"0.50.0"`) {
		t.Errorf("missing client_version: %s", gotBody)
	}
	if !strings.Contains(gotBody, `"wrapper_version":"2.5.0"`) {
		t.Errorf("missing wrapper_version: %s", gotBody)
	}
}

func TestCronReportRequiresAtLeastOneVersion(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("server should not have been called")
	})
	err := c.CronReport(context.Background(), CronReportRequest{Engine: "codex"})
	if err == nil {
		t.Fatal("expected error on empty payload")
	}
}
