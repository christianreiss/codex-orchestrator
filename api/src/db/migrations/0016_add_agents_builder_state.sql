-- Structured provenance for toggle-composed AGENTS.md versions. The rendered
-- body remains the immutable serving source of truth; this JSON only lets the
-- admin UI reopen the exact builder selection that produced it.
ALTER TABLE agents_documents
  ADD COLUMN builder_state JSON NULL AFTER body;
