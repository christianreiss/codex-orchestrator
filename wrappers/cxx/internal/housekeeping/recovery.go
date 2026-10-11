package housekeeping

import (
	"context"
	"errors"
	"os"
	"path/filepath"
)

var errSelectionChanged = errors.New("session changed; housekeeping rolled back without deleting transcripts; any conflicting copy remains in quarantine")

// Before the indexing phase, a changed selection can be restored safely.
// Older journals did not mark the indexing boundary: an unmoved artifact
// proves indexes were not reached, otherwise their state is ambiguous.
func checkMovingSnapshot(root string, j *journal) (changed, rollbackSafe bool, err error) {
	rollbackSafe = j.Version >= 2
	for _, m := range j.Moves {
		if err = validateMove(root, j.Token, m); err != nil {
			return
		}
		_, quarantineErr := os.Lstat(m.Quarantine)
		if os.IsNotExist(quarantineErr) {
			rollbackSafe = true
		} else if quarantineErr != nil {
			return false, false, quarantineErr
		} else if err = safePath(root, m.Quarantine); err != nil {
			return
		}
		st, originalErr := os.Lstat(m.Original)
		if os.IsNotExist(originalErr) && quarantineErr == nil {
			continue // This artifact already moved in the interrupted run.
		}
		if originalErr != nil && !os.IsNotExist(originalErr) {
			return false, false, originalErr
		}
		if originalErr != nil || quarantineErr == nil || !st.Mode().IsRegular() || st.Size() != m.Size || !st.ModTime().Equal(m.Modified) {
			changed = true
		}
	}
	return
}

func rollbackJournal(ctx context.Context, root, path string, j *journal, server Server, idleChecks ...func() error) error {
	if j.Phase != "rolling_back" {
		j.Phase = "rolling_back"
		if err := writeJSON(path, j); err != nil {
			return err
		}
	}
	var retained []string
	for _, m := range j.Moves {
		for _, check := range idleChecks {
			if err := check(); err != nil {
				return err
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := validateMove(root, j.Token, m); err != nil {
			return err
		}
		_, err := os.Lstat(m.Quarantine)
		if os.IsNotExist(err) {
			if _, err = os.Lstat(m.Original); err != nil {
				return errors.New("rollback artifact missing from both locations")
			}
			continue
		}
		if err != nil {
			return err
		}
		if err = safePath(root, m.Quarantine); err != nil {
			return err
		}
		if err = ensureRealDir(root, filepath.Dir(m.Original)); err != nil {
			return err
		}
		// Link is an atomic no-replace operation, unlike Rename. A raw CLI
		// may have recreated the original even after our idle check.
		if err = os.Link(m.Quarantine, m.Original); os.IsExist(err) {
			original, originalErr := os.Lstat(m.Original)
			backup, backupErr := os.Lstat(m.Quarantine)
			if originalErr != nil || backupErr != nil || !os.SameFile(original, backup) {
				retained = append(retained, m.Quarantine)
				continue
			}
		} else if err != nil {
			return err
		}
		if err = os.Remove(m.Quarantine); err != nil {
			return err
		}
		removeEmptyParents(root, filepath.Dir(m.Quarantine))
	}
	if len(retained) > 0 {
		receiptDir := filepath.Join(root, ".cxx-housekeeping/recovered")
		if err := ensureRealDir(root, receiptDir); err != nil {
			return err
		}
		if err := writeJSON(filepath.Join(receiptDir, j.Token+".json"), map[string]any{"token": j.Token, "retained_copies": retained}); err != nil {
			return err
		}
	}
	if err := server.Release(ctx, j.Token); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	j.Bytes, j.Count = 0, 0
	return errSelectionChanged
}
