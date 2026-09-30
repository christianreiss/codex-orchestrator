// Run inside the API container, after a database backup:
// docker compose exec -T api node --input-type=module - 1 5 6 --apply < scripts/consolidate-provider-accounts.mjs
// Without --apply, prints the proposed consolidation and rolls back.
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
const ids = process.argv.slice(2).filter((arg) => arg !== '--apply').map(Number);
if (ids.length < 2 || new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
  throw new Error('Supply the surviving account ID followed by duplicate account IDs');
const [survivor, ...duplicates] = ids;
const db = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
});
try {
  await db.beginTransaction();
  const marks = ids.map(() => '?').join(',');
  const [accounts] = await db.query(`SELECT * FROM provider_accounts WHERE id IN (${marks}) ORDER BY id FOR UPDATE`, ids);
  if (accounts.length !== ids.length || accounts.some((a) => a.state !== 'enabled' || a.merged_into_account_id))
    throw new Error('Every specified account must exist, be enabled, and not already merged');
  const engine = accounts[0].engine;
  if (accounts.some((a) => a.engine !== engine)) throw new Error('Cannot merge different engines');
  const known = new Set(accounts.map((a) => a.identity_key).filter((key) => key && !key.startsWith('credential:')));
  if (known.size > 1) throw new Error('Cannot merge conflicting provider identities');
  const [compatibilityHeads] = await db.query('SELECT * FROM auth_canonical_heads WHERE engine=? FOR UPDATE', [engine]);
  const [payloads] = await db.query(`SELECT id,account_id,generation,last_refresh,verification_state,body IS NOT NULL has_body FROM auth_payloads WHERE engine=? AND account_id IN (${marks}) FOR UPDATE`, [engine, ...ids]);
  const generations = payloads.map((p) => p.generation).filter((g) => g !== null).map(String);
  if (new Set(generations).size !== generations.length) throw new Error('Generation collision; consolidation requires explicit renumbering');
  const heads = payloads.filter((p) => accounts.some((a) => a.payload_id === p.id) && p.verification_state === 'verified' && p.has_body);
  heads.sort((a, b) => Date.parse(b.last_refresh) - Date.parse(a.last_refresh) || b.id - a.id);
  const head = heads[0];
  if (!head) throw new Error('No verified canonical credential head to preserve');
  const now = new Date().toISOString();
  const summary = { survivor, duplicates, engine, payload_id: head.id, generation: head.generation, applied: apply };
  if (apply) {
    const duplicateMarks = duplicates.map(() => '?').join(',');
    for (const table of ['auth_payloads', 'provider_account_sessions', 'chatgpt_usage_snapshots', 'claude_usage_snapshots', 'auth_seed_tokens'])
      await db.query(`UPDATE ${table} SET account_id=? WHERE account_id IN (${duplicateMarks})`, [survivor, ...duplicates]);
    await db.query('UPDATE auth_payloads SET superseded_at=?,purge_after=? WHERE engine=? AND account_id=? AND id<>? AND superseded_at IS NULL',
      [now, new Date(Date.now() + 7 * 86400_000).toISOString(), engine, survivor, head.id]);
    await db.query('UPDATE auth_payloads SET superseded_at=NULL,purge_after=NULL WHERE id=?', [head.id]);
    await db.query(`UPDATE provider_accounts SET state='removed',payload_id=NULL,generation=NULL,identity_key=NULL,merged_into_account_id=?,updated_at=? WHERE id IN (${duplicateMarks})`, [survivor, now, ...duplicates]);
    await db.query('UPDATE provider_accounts SET payload_id=?,generation=?,identity_key=?,updated_at=? WHERE id=?',
      [head.id, head.generation, [...known][0] ?? null, now, survivor]);
    if (compatibilityHeads.some((h) => payloads.some((p) => p.id === h.payload_id)))
      await db.query('UPDATE auth_canonical_heads SET payload_id=?,generation=?,updated_at=? WHERE engine=?', [head.id, head.generation, now, engine]);
    await db.query('INSERT INTO logs (action,details,created_at) VALUES (?,?,?)',
      ['account.consolidated', JSON.stringify({ ...summary, reason: 'Operator-confirmed duplicate accounts caused by opaque login-token enrollment' }), now]);
    await db.commit();
  } else await db.rollback();
  console.log(JSON.stringify(summary));
} catch (error) {
  await db.rollback();
  throw error;
} finally {
  await db.end();
}
