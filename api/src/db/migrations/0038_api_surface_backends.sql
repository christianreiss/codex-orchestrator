-- Any-to-any inference gateways: each exposed API surface (`/v1`,
-- `/anthropic/v1`, `/grok/v1`) names the backend engine that serves it.
-- Existing installs keep exactly today's wiring: every surface on its own
-- engine. The API also treats a missing row as that identity mapping, so this
-- seed only makes the state explicit. INSERT IGNORE never overwrites an
-- admin's choice on re-run.
INSERT IGNORE INTO versions (name, version, updated_at) VALUES
  ('api_surface_backend_openai', 'codex', '1970-01-01T00:00:00.000Z'),
  ('api_surface_backend_anthropic', 'claude', '1970-01-01T00:00:00.000Z'),
  ('api_surface_backend_grok', 'grok', '1970-01-01T00:00:00.000Z');
