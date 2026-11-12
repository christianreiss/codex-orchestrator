package communicator

// ConnectionMatrix counts attachments, not agents. A native launch can own
// several columns. State columns are unknown without a negotiated authority.
type ConnectionMatrix struct {
	StateAvailable bool            `json:"state_available"`
	Rows           []ConnectionRow `json:"rows"`
}

type ConnectionRow struct {
	Engine   string `json:"engine"`
	Lease    int    `json:"lease"`
	Auth     int    `json:"auth"`
	Provider int    `json:"provider"`
	Session  int    `json:"session"`
	Receiver int    `json:"receiver"`
	Other    int    `json:"other"`
}

type leaseClass struct {
	engine string
	auth   bool
}

func matrixEngine(engine string) string {
	switch engine {
	case "codex", "claude", "grok", "kimi", "shared":
		return engine
	default:
		return "unknown"
	}
}

// Caller holds server.mu. Count each lease once, including multi-engine scopes.
func (s *server) classifyLeaseLocked(ids []string) leaseClass {
	class := leaseClass{engine: "unknown"}
	for i, id := range ids {
		job := s.jobs[id]
		engine := matrixEngine(job.Engine)
		if i == 0 {
			class.engine = engine
		} else if class.engine != engine {
			class.engine = "shared"
		}
		class.auth = class.auth || job.Auth
	}
	return class
}

func (s *server) connectionMatrixLocked() ConnectionMatrix {
	out := ConnectionMatrix{Rows: make([]ConnectionRow, 6)}
	rows := map[string]*ConnectionRow{}
	for i, engine := range []string{"codex", "claude", "grok", "kimi", "shared", "unknown"} {
		out.Rows[i].Engine = engine
		rows[engine] = &out.Rows[i]
	}
	knownLeases := 0
	for class, n := range s.leaseClasses {
		row := rows[matrixEngine(class.engine)]
		if class.auth {
			row.Auth += n
		} else {
			row.Lease += n
		}
		knownLeases += n
	}
	// Legacy/unattributed attachments stay visible, never guessed from totals.
	if s.leases > knownLeases {
		rows["unknown"].Lease += s.leases - knownLeases
	}
	if s.conn == nil {
		return out
	}
	s.conn.mu.Lock()
	defer s.conn.mu.Unlock()
	out.StateAvailable = s.conn.stateEnabled
	if !out.StateAvailable {
		return out
	}
	for _, stream := range s.conn.states {
		if stream.epoch == "" || stream.stopping {
			continue
		}
		row := rows[matrixEngine(stream.engine)]
		switch stream.topic {
		case "provider":
			row.Provider++
		case "session":
			row.Session++
		case "receiver":
			row.Receiver++
		default:
			row.Other++
		}
	}
	return out
}
