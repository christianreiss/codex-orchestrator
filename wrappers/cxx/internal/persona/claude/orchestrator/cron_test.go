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
				"url":            "/wrapper/v2/download/clx-linux-amd64",
			},
			"target_version": "1.0.40",
			"enforce_exact":  false,
		})
	})
	resp, err := c.CronCheck(context.Background(), CronCheckRequest{
		Engine:         "claude",
		ClientVersion:  "1.0.39",
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
	if !strings.Contains(gotBody, `"engine":"claude"`) {
		t.Errorf("missing engine in body: %s", gotBody)
	}
	if !strings.Contains(gotBody, `"client_version":"1.0.39"`) {
		t.Errorf("missing client_version: %s", gotBody)
	}
	if resp.Action != "update" {
		t.Errorf("action=%s", resp.Action)
	}
	if resp.Wrapper == nil || resp.Wrapper.SHA256 != "deadbeef" {
		t.Fatalf("wrapper block: %+v", resp.Wrapper)
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
	if !strings.Contains(body, `"engine":"claude"`) {
		t.Errorf("default engine missing: %s", body)
	}
}

func TestCronReportRoundTrip(t *testing.T) {
	var gotBody string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		buf, _ := io.ReadAll(r.Body)
		gotBody = string(buf)
		_, _ = w.Write([]byte(`{"recorded":true}`))
	})
	err := c.CronReport(context.Background(), CronReportRequest{
		Engine:         "claude",
		ClientVersion:  "1.0.40",
		WrapperVersion: "2.5.0",
	})
	if err != nil {
		t.Fatalf("CronReport: %v", err)
	}
	if !strings.Contains(gotBody, `"engine":"claude"`) {
		t.Errorf("missing engine: %s", gotBody)
	}
}

func TestCronReportRequiresAtLeastOneVersion(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("server should not have been called")
	})
	err := c.CronReport(context.Background(), CronReportRequest{Engine: "claude"})
	if err == nil {
		t.Fatal("expected error on empty payload")
	}
}
