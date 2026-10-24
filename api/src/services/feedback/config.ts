import { ownerRuntimeFor, mutateOwnerState } from '../../control-plane/state/runtime.js';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adminEvents, versions } from '../../db/schema.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt, decrypt } from '../../security/secret-box.js';
import { ConflictError, ValidationError } from '../../http/errors.js';
import { wsPublisher } from '../../ws/publisher.js';
import { SettingsService } from '../settings.js';
import { configSchema, FEEDBACK_CONFIG_KEY, FEEDBACK_MODE_KEY, FEEDBACK_TOKEN_KEY, UPSTREAM_REPOSITORY } from './contract.js';

export class FeedbackConfiguration {
  private settings: SettingsService;
  constructor(private db: Database, private keyring: Keyring) { this.settings = new SettingsService(db); }
  async read() {
    const [raw, mode, token] = await Promise.all([
      this.settings.getRaw(FEEDBACK_CONFIG_KEY), this.settings.getRaw(FEEDBACK_MODE_KEY), this.settings.getRaw(FEEDBACK_TOKEN_KEY),
    ]);
    const data = raw ? JSON.parse(raw) as { revision: string; auto_publish: boolean; runner_enabled: boolean; engine: 'codex' | 'claude' | 'grok' | null; model: string | null } : {
      revision: 'initial', auto_publish: false, runner_enabled: false, engine: null, model: null,
    };
    return { ...configSchema.parse({ mode: mode === 'user' ? 'user' : 'source_developer', auto_publish: data.auto_publish,
      runner_enabled: data.runner_enabled, engine: data.engine, model: data.model }),
      revision: data.revision, token_configured: Boolean(token), repository: UPSTREAM_REPOSITORY };
  }
  async token(): Promise<string | null> {
    const value = await this.settings.getRaw(FEEDBACK_TOKEN_KEY);
    return value ? decrypt(value, this.keyring) : null;
  }
  async save(input: unknown, adminUserId: number) {
    const { z } = await import('zod');
    const args = z.object({ expected_revision: z.string(), config: configSchema,
      token: z.string().trim().min(1).max(500).optional(), disconnect: z.boolean().optional(),
    }).strict().parse(input);
    if (args.token && args.disconnect) throw new ValidationError('Choose either a new token or disconnect');
    const current = await this.read();
    if (current.revision !== args.expected_revision) throw new ConflictError('Feedback settings changed; reload before saving');
    const revision = randomUUID();
    const tokenEnc = args.token ? encrypt(args.token, this.keyring) : null;
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      await mutateOwnerState(owner, { kind: 'feedback.configuration', payload: { revision, expected_revision: args.expected_revision }, prepare(context) {
        const previous = JSON.parse(context.snapshot.setting(FEEDBACK_CONFIG_KEY) ?? '{"revision":"initial"}') as { revision?: string };
        if (previous.revision !== args.expected_revision) throw new ConflictError('Feedback settings changed; reload before saving');
        const now = new Date().toISOString();
        const values = [{ name: FEEDBACK_MODE_KEY, version: args.config.mode, updatedAt: now }, { name: FEEDBACK_CONFIG_KEY, version: JSON.stringify({ ...args.config, revision }), updatedAt: now }, ...(tokenEnc ? [{ name: FEEDBACK_TOKEN_KEY, version: tokenEnc, updatedAt: now }] : [])];
        for (const row of values) context.draft.upsert('versions', row);
        if (args.disconnect) context.draft.remove('versions', FEEDBACK_TOKEN_KEY);
        context.write(async tx => {
          for (const row of values) await tx.insert(versions).values(row).onDuplicateKeyUpdate({ set: { version: row.version, updatedAt: now } });
          if (args.disconnect) await tx.delete(versions).where(eq(versions.name, FEEDBACK_TOKEN_KEY));
          await tx.insert(adminEvents).values({ type: 'feedback.configuration', hostId: null, createdAt: now, payload: { admin_user_id: adminUserId, ...args.config, revision, token_changed: Boolean(tokenEnc || args.disconnect) } });
        });
        return null;
      } });
      wsPublisher.publish('feedback.changed', { configuration: true }); return this.read();
    }
    await this.db.transaction(async (tx) => {
      // Serialize the initial configuration and every following revision.
      await tx.insert(versions).values({ name: FEEDBACK_CONFIG_KEY, version: JSON.stringify({ ...current, revision: 'initial' }), updatedAt: new Date().toISOString() })
        .onDuplicateKeyUpdate({ set: { name: FEEDBACK_CONFIG_KEY } });
      const [locked] = await tx.select().from(versions).where(eq(versions.name, FEEDBACK_CONFIG_KEY)).for('update');
      const previous = JSON.parse(locked!.version ?? '{}') as { revision?: string };
      if (previous.revision !== args.expected_revision) throw new ConflictError('Feedback settings changed; reload before saving');
      const write = async (name: string, value: string) => {
        await tx.insert(versions).values({ name, version: value, updatedAt: new Date().toISOString() })
          .onDuplicateKeyUpdate({ set: { version: value, updatedAt: new Date().toISOString() } });
      };
      await write(FEEDBACK_MODE_KEY, args.config.mode);
      await write(FEEDBACK_CONFIG_KEY, JSON.stringify({ ...args.config, revision }));
      if (tokenEnc) await write(FEEDBACK_TOKEN_KEY, tokenEnc);
      if (args.disconnect) await tx.delete(versions).where(eq(versions.name, FEEDBACK_TOKEN_KEY));
      await tx.insert(adminEvents).values({ type: 'feedback.configuration', hostId: null, createdAt: new Date().toISOString(),
        payload: { admin_user_id: adminUserId, ...args.config, revision, token_changed: Boolean(tokenEnc || args.disconnect) } });
    });
    wsPublisher.publish('feedback.changed', { configuration: true });
    return this.read();
  }
}

export const reportDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
