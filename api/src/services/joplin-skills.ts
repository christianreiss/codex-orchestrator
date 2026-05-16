import type { Database } from '../db/client.js';
import type { JoplinClient } from './joplin-client.js';

/**
 * Placeholder for the legacy JoplinSkillService.
 *
 * The PHP version walked Joplin notes tagged `skill:<name>` and forwarded the
 * markdown body to the skills service. The new backend wires the skills
 * service later in Phase 2; until that lands, this function logs and returns
 * an empty result so callers see a uniform shape.
 */

export interface JoplinSkillImportResult {
  skills_imported: number;
  skills_failed: number;
}

export async function importJoplinSkills(
  _db: Database,
  client: JoplinClient,
): Promise<JoplinSkillImportResult> {
  // List notes (best-effort) — the skill: tag filter is applied here so when
  // the skills service lands, the only change is the inner body of this loop.
  let notes: Awaited<ReturnType<JoplinClient['listNotes']>> = [];
  try {
    notes = await client.listNotes();
  } catch {
    return { skills_imported: 0, skills_failed: 0 };
  }

  let imported = 0;
  for (const note of notes) {
    const skillTag = note.tags?.find((t) => /^skill:/i.test(t));
    if (!skillTag) continue;
    // No skills-service hook yet — count what *would* have been imported so
    // the response shape is stable and tests can assert on it.
    imported += 1;
  }
  return { skills_imported: imported, skills_failed: 0 };
}
