/** Opt-in live transport check against the Android instrumentation fixture. */
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import type { Env } from '../src/env.js';
import { FcmTransport } from '../src/services/companion/fcm.js';

const adb = process.env.ADB ?? 'adb';
const serial = process.env.ANDROID_SERIAL;
if (!serial) throw new Error('Set ANDROID_SERIAL to the test emulator');
if (!process.env.COMPANION_FIREBASE_CONFIG_FILE || !process.env.COMPANION_FIREBASE_CREDENTIAL_FILE) {
  throw new Error('Set COMPANION_FIREBASE_CONFIG_FILE and COMPANION_FIREBASE_CREDENTIAL_FILE');
}
const transport = new FcmTransport(process.env as unknown as Env);
const deadline = Date.now() + 180_000;
let sent = false;
while (Date.now() < deadline) {
  let request: { token?: string; notification_id?: string };
  try {
    request = JSON.parse(execFileSync(adb, ['-s', serial, 'shell', 'run-as', 'io.uggs.orchestrator',
      'cat', 'files/fcm-delivery-test.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    await setTimeout(1000);
    continue;
  }
  if (!request.token || !request.notification_id || !/^[a-f0-9-]{36}$/.test(request.notification_id)) {
    throw new Error('Invalid instrumentation fixture');
  }
  const result = await transport.send(request.token, {
    notification_id: request.notification_id, device_id: 'test-device', kind: 'approval', target_id: '42',
  }, 120);
  if (result !== 'sent') throw new Error('Test device token was rejected');
  process.stdout.write('FCM accepted the test approval; Android instrumentation verifies display and review.\n');
  sent = true;
  break;
}
if (!sent) throw new Error('Timed out waiting for Android instrumentation');
