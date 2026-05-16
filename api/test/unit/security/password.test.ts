import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { hash, verify } from '../../../src/security/password.js';

describe('password.verify', () => {
  it('verifies an argon2id hash without proposing a rehash', async () => {
    const stored = await hash('hunter2');
    const result = await verify(stored, 'hunter2');
    expect(result.ok).toBe(true);
    expect(result.rehash).toBeUndefined();
  });

  it('rejects a wrong argon2 password', async () => {
    const stored = await hash('hunter2');
    const result = await verify(stored, 'wrong');
    expect(result.ok).toBe(false);
  });

  it('verifies a $2a$ bcrypt hash and proposes an argon2 rehash', async () => {
    const stored = bcrypt.hashSync('legacy-pass', 8);
    const result = await verify(stored, 'legacy-pass');
    expect(result.ok).toBe(true);
    expect(result.rehash?.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies a $2y$ bcrypt variant (PHP password_hash output)', async () => {
    // bcryptjs writes $2a$; PHP writes $2y$. Same algorithm; we should accept both.
    const raw = bcrypt.hashSync('hi', 6);
    const phpStyle = '$2y$' + raw.slice(4);
    const result = await verify(phpStyle, 'hi');
    expect(result.ok).toBe(true);
    expect(result.rehash?.startsWith('$argon2id$')).toBe(true);
  });

  it('returns ok:false for unknown hash formats', async () => {
    expect((await verify('plain-text', 'plain-text')).ok).toBe(false);
    expect((await verify('', '')).ok).toBe(false);
  });
});
