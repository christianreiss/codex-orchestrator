import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Env } from '../../env.js';

export interface FirebaseClientConfig {
  project_id: string;
  app_id: string;
  api_key: string;
  sender_id: string;
}
const googleConfig = z.object({
  project_info: z.object({ project_id: z.string().min(1), project_number: z.string().min(1) }),
  client: z.array(
    z.object({
      client_info: z.object({
        mobilesdk_app_id: z.string().min(1),
        android_client_info: z.object({ package_name: z.string() }),
      }),
      api_key: z.array(z.object({ current_key: z.string().min(1) })).min(1),
    }),
  ),
});

/** Public app identifiers only. Service-account material uses a separate mounted file. */
export function firebaseClientConfig(env: Env): FirebaseClientConfig | null {
  if (env.COMPANION_FIREBASE_CONFIG_FILE) {
    try {
      const config = googleConfig.parse(JSON.parse(readFileSync(env.COMPANION_FIREBASE_CONFIG_FILE, 'utf8')));
      const client = config.client.find(
        (c) => c.client_info.android_client_info.package_name === 'io.uggs.orchestrator',
      );
      if (!client) throw new Error('package mismatch');
      return {
        project_id: config.project_info.project_id,
        sender_id: config.project_info.project_number,
        app_id: client.client_info.mobilesdk_app_id,
        api_key: client.api_key[0]!.current_key,
      };
    } catch {
      throw new Error(
        'Invalid companion Firebase configuration: expected google-services.json for io.uggs.orchestrator',
      );
    }
  }
  if (
    !env.COMPANION_FIREBASE_PROJECT_ID ||
    !env.COMPANION_FIREBASE_APP_ID ||
    !env.COMPANION_FIREBASE_API_KEY ||
    !env.COMPANION_FIREBASE_SENDER_ID
  )
    return null;
  return {
    project_id: env.COMPANION_FIREBASE_PROJECT_ID,
    app_id: env.COMPANION_FIREBASE_APP_ID,
    api_key: env.COMPANION_FIREBASE_API_KEY,
    sender_id: env.COMPANION_FIREBASE_SENDER_ID,
  };
}
