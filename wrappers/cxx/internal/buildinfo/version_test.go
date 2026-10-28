package buildinfo

import "testing"

func TestReleaseRecognisesOnlyVersionedBuilds(t *testing.T) {
	old := Version
	t.Cleanup(func() { Version = old })
	for version, want := range map[string]bool{
		"0.9.142": true, "v1.2.3": true, "1.0.0-rc1": true, "1.0.0+local": true,
		"dev": false, "": false, "unknown": false, "1.2": false, "1..3": false, "1.2.x": false,
	} {
		Version = version
		if got := Release(); got != want {
			t.Fatalf("Release() for %q = %v, want %v", version, got, want)
		}
	}
}
