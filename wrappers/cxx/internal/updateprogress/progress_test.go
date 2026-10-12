package updateprogress

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestReaderReportsActualBytesAndUnknownLength(t *testing.T) {
	for _, total := range []int64{6, -1} {
		var events []Event
		ctx := WithObserver(context.Background(), func(event Event) { events = append(events, event) })
		body, err := io.ReadAll(Reader(ctx, strings.NewReader("abcdef"), total))
		if err != nil || string(body) != "abcdef" {
			t.Fatal("reader changed data")
		}
		last := events[len(events)-1]
		if last.Bytes != 6 || last.Total != total || last.Phase != "downloading" {
			t.Fatalf("event=%+v", last)
		}
	}
}

func TestTransferLabelIsScopedAndChangesBetweenArtifacts(t *testing.T) {
	var events []Event
	base := WithObserver(context.Background(), func(event Event) { events = append(events, event) })
	for _, label := range []string{"CLI", "companion"} {
		_, _ = io.ReadAll(Reader(WithArtifact(base, label), strings.NewReader("abcdef"), 6))
	}
	Emit(base, Event{Phase: "syncing"})
	var starts []string
	for _, event := range events {
		if event.Phase == "downloading" && event.Bytes == 0 {
			starts = append(starts, event.Artifact)
		}
	}
	if strings.Join(starts, ",") != "CLI,companion" || events[len(events)-1].Artifact != "" {
		t.Fatalf("transfer state leaked: %+v", events)
	}
}
