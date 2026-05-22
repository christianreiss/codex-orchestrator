package summary

import "testing"

func TestQuotaProjectionNoteShowsPercentAtReset(t *testing.T) {
	got := quotaProjectionNote(24, int64(5*3600), int64(2*3600+27*60))
	if got != "~47% at reset" {
		t.Fatalf("quotaProjectionNote() = %q, want %q", got, "~47% at reset")
	}
}

func TestQuotaProjectionNoteKeepsTimeToFullWhenCrossingLimit(t *testing.T) {
	got := quotaProjectionNote(50, int64(5*3600), int64(4*3600))
	if got != "~250% at reset; 100% in 1h" {
		t.Fatalf("quotaProjectionNote() = %q, want %q", got, "~250% at reset; 100% in 1h")
	}
}

func TestQuotaProjectionNoteSkipsFreshWindow(t *testing.T) {
	if got := quotaProjectionNote(5, int64(5*3600), int64(5*3600)); got != "" {
		t.Fatalf("quotaProjectionNote() = %q, want empty", got)
	}
}
