package modelpolicy

// ResetAnnounced lets external tests restore the process-wide notice state.
func ResetAnnounced() { announced.Store(false) }
