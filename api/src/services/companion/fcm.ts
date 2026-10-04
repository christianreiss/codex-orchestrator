import { firebaseClientConfig } from './firebase-config.js';
import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import type { Env } from '../../env.js';

/** Minimal FCM HTTP v1 transport. Credentials never travel to the app or logs. */
export class FcmTransport {
  private access: { token: string; until: number } | undefined;
  private readonly projectId: string | undefined;
  constructor(private readonly env: Env) {
    this.projectId = firebaseClientConfig(env)?.project_id ?? env.COMPANION_FIREBASE_PROJECT_ID;
  }
  get configured() {
    return !!this.env.COMPANION_FIREBASE_CREDENTIAL_FILE && !!this.projectId;
  }
  private async bearer() {
    if (this.access && this.access.until > Date.now()) return this.access.token;
    const credential = JSON.parse(await readFile(this.env.COMPANION_FIREBASE_CREDENTIAL_FILE!, 'utf8')) as {
      client_email: string;
      private_key: string;
      project_id: string;
    };
    if (credential.project_id !== this.projectId) throw new Error('Firebase project mismatch');
    const now = Math.floor(Date.now() / 1000);
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: credential.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(body);
    const assertion = `${body}.${signer.sign(credential.private_key, 'base64url')}`;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Firebase authentication HTTP ${response.status}`);
    const result = (await response.json()) as { access_token: string; expires_in: number };
    this.access = { token: result.access_token, until: Date.now() + (result.expires_in - 60) * 1000 };
    return result.access_token;
  }
  async send(token: string, data: Record<string, string>, ttl: number): Promise<'sent' | 'invalid'> {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId!)}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.bearer()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: { token, data, android: { priority: 'HIGH', ttl: `${Math.max(0, ttl)}s` } },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.ok) return 'sent';
    const body = (await response.json().catch(() => ({}))) as {
      error?: { details?: { errorCode?: string }[] };
    };
    if (body.error?.details?.some((d) => d.errorCode === 'UNREGISTERED')) return 'invalid';
    if (response.status === 401) this.access = undefined;
    throw new Error(`FCM send HTTP ${response.status}`);
  }
}
