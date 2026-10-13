//go:build !linux

package communicator

import (
	"context"
	"errors"
)

type residentAdoption struct{}

func (*residentAdoption) acquired() error { return errors.New("resident adoption requires Linux") }
func adoptOnDemandOwner(context.Context, string) (*residentAdoption, error) {
	return nil, errors.New("resident adoption requires Linux")
}
