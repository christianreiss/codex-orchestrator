package communicator

import (
	"context"
	"time"
)

// A connection-mode Grok lease answers 404 "Account session not found" while
// it has no live provider attachment. The attachment redials every second, so
// the gap is usually well under a second and the lease is healthy again right
// after. A 404 is therefore only counted as revoked auth once it has been
// re-checked and answered 404 every time. Other revocation classes (401, 409)
// are authoritative and are never delayed by this.
const (
	// NotFoundRechecks is the number of re-checks after the first 404.
	NotFoundRechecks = 3
	// NotFoundRecheckSpacing is the pause before each re-check, so a persistent
	// 404 is confirmed after about 4.5 s in total.
	NotFoundRecheckSpacing = 1500 * time.Millisecond
)

// RecheckPolicy parameterizes ConfirmNotFound. The zero value means the
// production constants above and a context-aware real-time wait.
type RecheckPolicy struct {
	Rechecks int
	Spacing  time.Duration
	// Wait pauses for d or returns ctx.Err(). Tests replace it with a fake clock.
	Wait func(ctx context.Context, d time.Duration) error
}

func (p RecheckPolicy) withDefaults() RecheckPolicy {
	if p.Rechecks <= 0 {
		p.Rechecks = NotFoundRechecks
	}
	if p.Spacing <= 0 {
		p.Spacing = NotFoundRecheckSpacing
	}
	if p.Wait == nil {
		p.Wait = realWait
	}
	return p
}

func realWait(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// ConfirmNotFound is called after a first check answered with a not-found
// error. It re-runs recheck up to policy.Rechecks times, one Spacing apart,
// and returns the outcome the caller must classify as usual:
//   - nil, or any error for which isNotFound is false, as soon as one re-check
//     answers differently (a 401 stays immediately fatal, a 200 or 503 is not);
//   - the last not-found error if every re-check also answered not-found;
//   - ctx.Err() if the context ends first, without waiting out the spacing.
func ConfirmNotFound(ctx context.Context, policy RecheckPolicy, recheck func(context.Context) error, isNotFound func(error) bool) error {
	policy = policy.withDefaults()
	var last error
	for i := 0; i < policy.Rechecks; i++ {
		if err := policy.Wait(ctx, policy.Spacing); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		last = recheck(ctx)
		if last == nil || !isNotFound(last) {
			return last
		}
	}
	return last
}
