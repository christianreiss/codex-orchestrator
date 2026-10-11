package lifecycle

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestAtomicWriteConcurrentWritersPublishWholeDocuments(t *testing.T) {
	for _, base := range []string{"AGENTS.md", "config.toml"} {
		t.Run(base, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), base)
			const writers = 16
			start := make(chan struct{})
			errs := make(chan error, writers)
			var wg sync.WaitGroup
			bodies := make([][]byte, writers)
			for i := range bodies {
				bodies[i] = bytes.Repeat([]byte(fmt.Sprintf("writer-%02d\n", i)), 32*1024+i)
				wg.Add(1)
				go func(body []byte) {
					defer wg.Done()
					<-start
					errs <- atomicWrite(path, body, 0o600)
				}(bodies[i])
			}
			close(start)
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Errorf("writer failed: %v", err)
				}
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			whole := false
			for _, body := range bodies {
				whole = whole || bytes.Equal(got, body)
			}
			if !whole {
				t.Fatal("published file is not any complete writer document")
			}
			entries, err := os.ReadDir(filepath.Dir(path))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 {
				t.Fatalf("temporary files left behind: %v", entries)
			}
			info, _ := os.Stat(path)
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("mode = %o", info.Mode().Perm())
			}
		})
	}
}
