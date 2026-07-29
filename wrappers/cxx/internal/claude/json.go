package claude

import "encoding/json"

// unmarshalLoose tolerates extra fields. Wrapper around encoding/json with a
// small fix for callers that pass raw bytes that already happen to be valid.
func unmarshalLoose(raw []byte, v any) error {
	return json.Unmarshal(raw, v)
}
