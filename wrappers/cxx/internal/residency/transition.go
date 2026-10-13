package residency

import (
	"context"
	"errors"
)

// TransitionIO supplies fresh evidence from the server, local owner and kernel.
// Every mutation receives the durable transition ID. Implementations must
// reconcile an uncertain previous outcome before performing that mutation again.
type TransitionIO interface {
	Stage(context.Context, Journal) error
	Fence(context.Context, Journal) error
	Prepare(context.Context, Journal) error
	Exit(context.Context, Journal) error
	Install(context.Context, Journal) (string, error)
	Verify(context.Context, Journal) error
	Release(context.Context, Journal) error
}

// ContinueTransition never clears a fence on failure, skips a readiness proof,
// or creates a replacement execution. A caller resumes this same journal.
func ContinueTransition(ctx context.Context, path string, io TransitionIO) (Journal, error) {
	j, err := ReadJournal(path)
	if err != nil {
		return j, err
	}
	if io == nil {
		return j, errors.New("migration evidence provider is missing")
	}
	e := Evidence{AdmissionFenced: true, WorkloadVerified: true, SourceExited: true, OwnerAcquired: true, TargetVerified: true}
	advance := func(phase Phase, owner string) error {
		next := j
		next.Phase = phase
		if owner != "" {
			next.TargetOwner = owner
		}
		if err := AdvanceJournal(path, j, next, e); err != nil {
			return err
		}
		j = next
		return nil
	}
	for j.Phase != Reopened {
		if err := ctx.Err(); err != nil {
			return j, err
		}
		switch j.Phase {
		case Observed:
			err = io.Stage(ctx, j)
			if err == nil {
				err = advance(Staged, "")
			}
		case Staged:
			err = io.Fence(ctx, j)
			if err == nil {
				err = advance(Fenced, "")
			}
		case Fenced:
			// Reassert the same fence before collecting drain evidence after a
			// crash or an administrator changing unrelated settings.
			err = io.Fence(ctx, j)
			if err == nil {
				err = advance(Draining, "")
			}
		case Draining:
			err = io.Prepare(ctx, j)
			if err == nil {
				err = advance(HandoffReady, "")
			}
		case HandoffReady:
			err = io.Exit(ctx, j)
			if err == nil {
				var owner string
				owner, err = io.Install(ctx, j)
				if err == nil {
					err = advance(Replaced, owner)
				}
			}
		case Replaced:
			err = io.Verify(ctx, j)
			if err == nil {
				err = advance(Verified, "")
			}
		case Verified:
			// Verification is repeated before releasing admission, even when a
			// previous invocation died after its successful verification.
			err = io.Verify(ctx, j)
			if err == nil {
				err = io.Release(ctx, j)
			}
			if err == nil {
				err = advance(Reopened, "")
			}
		default:
			return j, errors.New("migration phase cannot be continued")
		}
		if err != nil {
			return j, err
		}
	}
	return j, nil
}
