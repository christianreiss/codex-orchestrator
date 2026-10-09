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
