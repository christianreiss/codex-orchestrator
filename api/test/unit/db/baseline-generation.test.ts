import { describe, expect, it } from 'vitest';
import { normalizeBaselineSql } from '../../../src/db/baseline-generation.js';

describe('MySQL baseline generation', () => {
  const name = 'companion_daemon_follows_daemon_session_id_host_daemon_sessions_id_fk';

  it('bounds generated FK and index identifiers without changing column references', () => {
    const sql = `ALTER TABLE \`companion_daemon_follows\` ADD CONSTRAINT \`${name}\` FOREIGN KEY (\`daemon_session_id\`) REFERENCES \`host_daemon_sessions\`(\`id\`);\n--> statement-breakpoint\nCREATE INDEX \`${name}\` ON \`companion_daemon_follows\` (\`daemon_session_id\`);`;
    const normalized = normalizeBaselineSql(sql);
    const identifiers = [...normalized.matchAll(/(?:CONSTRAINT|INDEX) `([^`]+)`/g)].map((match) => match[1]!);
    expect(identifiers).toHaveLength(2);
    expect(identifiers.every((identifier) => identifier.length === 64)).toBe(true);
    expect(identifiers[0]).toBe(identifiers[1]);
    expect(normalized).toContain('REFERENCES `host_daemon_sessions`(`id`)');
    expect(normalized).not.toContain('--> statement-breakpoint');
    expect(normalizeBaselineSql(sql)).toBe(normalized);
    expect(normalizeBaselineSql(normalized)).toBe(normalized);
  });

  it('keeps valid names and distinguishes long names with the same prefix', () => {
    expect(normalizeBaselineSql('CONSTRAINT `existing_fk`')).toBe('CONSTRAINT `existing_fk`');
    const prefix = 'x'.repeat(64);
    expect(normalizeBaselineSql(`CONSTRAINT \`${prefix}_one\``))
      .not.toBe(normalizeBaselineSql(`CONSTRAINT \`${prefix}_two\``));
    expect(normalizeBaselineSql(`CONSTRAINT \`${prefix}\``)).toBe(`CONSTRAINT \`${prefix}\``);
  });
});
