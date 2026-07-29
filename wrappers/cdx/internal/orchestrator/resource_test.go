package orchestrator

import (
	"encoding/json"
	"testing"
)

func TestResourceContent_TableDriven(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string // "" means resourceContent must return nil
		wantErr bool
	}{
		{name: "empty input", in: ""},
		{name: "null", in: `null`},
		{name: "whitespace padded null", in: " \n null \t"},
		{name: "json string is content", in: `"# managed doc\n"`, want: "# managed doc\n"},
		{name: "empty json string", in: `""`},
		{name: "content key", in: `{"status":"updated","version_id":1,"content":"# managed doc\n"}`, want: "# managed doc\n"},
		{name: "body key when content absent", in: `{"status":"updated","version_id":1,"body":"body doc\n"}`, want: "body doc\n"},
		{name: "empty content falls back to body", in: `{"content":"","body":"body doc\n"}`, want: "body doc\n"},
		{name: "object with neither key", in: `{"status":"unchanged","version_id":1,"sha256":"abc"}`},
		{name: "neither string nor object", in: `42`, wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resourceContent(json.RawMessage(tc.in))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got content %q", string(got))
				}
				if got != nil {
					t.Errorf("error case must yield no content: %q", string(got))
				}
				return
			}
			if err != nil {
				t.Fatalf("resourceContent: %v", err)
			}
			if tc.want == "" {
				if got != nil {
					t.Errorf("want no content, got %q", string(got))
				}
				return
			}
			if string(got) != tc.want {
				t.Errorf("content: got %q want %q", string(got), tc.want)
			}
		})
	}
}
