-- Seed the four Claude output-style documents for the response-verbosity dial
-- (Component B of the feature; see api/src/services/agent-response-style.ts).
--
-- Level 0 has no row here on purpose: it is the no-op level and its output
-- style would just be Claude Code's own built-in default, which
-- `client-config.ts` leaves untouched by omitting `outputStyle` entirely.
--
-- INSERT IGNORE against `uq_claude_artifacts_kind_slug` so a re-run is a
-- no-op and an operator who has since hand-edited one of these slugs via the
-- admin UI is never overwritten.

INSERT IGNORE INTO claude_artifacts
    (kind, slug, sha256, display_name, description, model, frontmatter, body, source_host_id, created_at, updated_at, deleted_at, engine)
VALUES
(
    'output-style',
    'verbosity-trimmed',
    SHA2('---
name: Verbosity Trimmed
description: Fleet response-verbosity level 1 - trims preamble and restated tasks.
---

Keep responses trimmed.

- Success: lead with the result immediately. No preamble, no restating the task, no closing summary. Supporting detail only where it changes what the user does next.
- Failure: state what failed and what remains, still without preamble.
', 256),
    'Verbosity Trimmed',
    'Fleet response-verbosity level 1 - trims preamble and restated tasks.',
    NULL,
    JSON_OBJECT('name', 'Verbosity Trimmed', 'description', 'Fleet response-verbosity level 1 - trims preamble and restated tasks.'),
    '---
name: Verbosity Trimmed
description: Fleet response-verbosity level 1 - trims preamble and restated tasks.
---

Keep responses trimmed.

- Success: lead with the result immediately. No preamble, no restating the task, no closing summary. Supporting detail only where it changes what the user does next.
- Failure: state what failed and what remains, still without preamble.
',
    NULL,
    '2026-08-18T00:00:00Z',
    '2026-08-18T00:00:00Z',
    NULL,
    'claude'
),
(
    'output-style',
    'verbosity-concise',
    SHA2('---
name: Verbosity Concise
description: Fleet response-verbosity level 2 - short paragraph or up to 4 bullets.
---

Keep responses concise.

- Success: a short paragraph or up to 4 bullets, result first. Skip anything the user would only skim.
- Failure: up to 4 sentences - what failed, the likely cause, what remains.
', 256),
    'Verbosity Concise',
    'Fleet response-verbosity level 2 - short paragraph or up to 4 bullets.',
    NULL,
    JSON_OBJECT('name', 'Verbosity Concise', 'description', 'Fleet response-verbosity level 2 - short paragraph or up to 4 bullets.'),
    '---
name: Verbosity Concise
description: Fleet response-verbosity level 2 - short paragraph or up to 4 bullets.
---

Keep responses concise.

- Success: a short paragraph or up to 4 bullets, result first. Skip anything the user would only skim.
- Failure: up to 4 sentences - what failed, the likely cause, what remains.
',
    NULL,
    '2026-08-18T00:00:00Z',
    '2026-08-18T00:00:00Z',
    NULL,
    'claude'
),
(
    'output-style',
    'verbosity-brief',
    SHA2('---
name: Verbosity Brief
description: Fleet response-verbosity level 3 - at most 3 sentences.
---

Keep responses brief.

- Success: at most 3 sentences, result first, no elaboration unless it is load-bearing.
- Failure: at most 3 sentences - what failed and what remains.
', 256),
    'Verbosity Brief',
    'Fleet response-verbosity level 3 - at most 3 sentences.',
    NULL,
    JSON_OBJECT('name', 'Verbosity Brief', 'description', 'Fleet response-verbosity level 3 - at most 3 sentences.'),
    '---
name: Verbosity Brief
description: Fleet response-verbosity level 3 - at most 3 sentences.
---

Keep responses brief.

- Success: at most 3 sentences, result first, no elaboration unless it is load-bearing.
- Failure: at most 3 sentences - what failed and what remains.
',
    NULL,
    '2026-08-18T00:00:00Z',
    '2026-08-18T00:00:00Z',
    NULL,
    'claude'
),
(
    'output-style',
    'verbosity-minimal',
    SHA2('---
name: Verbosity Minimal
description: Fleet response-verbosity level 4 - no more than 2 sentences.
---

Keep responses minimal.

- Success: no more than 2 sentences. One is preferred. No preamble, no summary, no restated task.
- Failure: no more than 2 sentences - what failed, what remains.
', 256),
    'Verbosity Minimal',
    'Fleet response-verbosity level 4 - no more than 2 sentences.',
    NULL,
    JSON_OBJECT('name', 'Verbosity Minimal', 'description', 'Fleet response-verbosity level 4 - no more than 2 sentences.'),
    '---
name: Verbosity Minimal
description: Fleet response-verbosity level 4 - no more than 2 sentences.
---

Keep responses minimal.

- Success: no more than 2 sentences. One is preferred. No preamble, no summary, no restated task.
- Failure: no more than 2 sentences - what failed, what remains.
',
    NULL,
    '2026-08-18T00:00:00Z',
    '2026-08-18T00:00:00Z',
    NULL,
    'claude'
);
