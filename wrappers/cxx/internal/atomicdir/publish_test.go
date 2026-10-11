//go:build linux || darwin

package atomicdir

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestReplacementNeverRemovesCanonicalDirectory(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "skill")
	if err := os.Mkdir(target, 0755); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	fail := make(chan error, 1)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				if _, err := os.Stat(target); err != nil {
					select {
					case fail <- err:
					default:
					}
					return
				}
			}
		}
	}()
	for i := 0; i < 100; i++ {
		stage, err := os.MkdirTemp(root, ".skill-")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(stage, "SKILL.md"), []byte("complete bundle"), 0644); err != nil {
			t.Fatal(err)
		}
		if err = Publish(stage, target, true); err != nil {
			t.Fatal(err)
		}
		if err = os.RemoveAll(stage); err != nil {
			t.Fatal(err)
		}
	}
	close(stop)
	wg.Wait()
	select {
	case err := <-fail:
		t.Fatal("canonical directory disappeared", err)
	default:
	}
}
func TestNewPublicationCannotReplaceConcurrentDirectory(t *testing.T) {
	root := t.TempDir()
	stage := filepath.Join(root, "stage")
	target := filepath.Join(root, "target")
	_ = os.Mkdir(stage, 0755)
	_ = os.Mkdir(target, 0755)
	if err := Publish(stage, target, false); err == nil {
		t.Fatal("unexpected replacement")
	}
	if _, err := os.Stat(stage); err != nil {
		t.Fatal("staging lost", err)
	}
}
