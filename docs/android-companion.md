# Android companion

The app is **Orchestrator**, package **`io.uggs.orchestrator`**, Android 8 or newer.
It connects to one orchestrator at a time; each phone is independently revocable.
Google Play services are needed for FCM, but chat and approval review work without
push. No Analytics SDK is included.

## Server and Firebase setup

1. Create/select a Firebase project and register an Android app with package
   `io.uggs.orchestrator`. Enable the Firebase Cloud Messaging HTTP v1 API.
2. Mount the downloaded `google-services.json` read-only and set
   `COMPANION_FIREBASE_CONFIG_FILE=/run/secrets/companion-google-services.json`.
   The matching `io.uggs.orchestrator` client is selected automatically.
   Alternatively, omit that file setting and set these public identifiers:

   ```dotenv
   COMPANION_FIREBASE_PROJECT_ID=your-project-id
   COMPANION_FIREBASE_APP_ID=1:123456789:android:your-app-id
   COMPANION_FIREBASE_API_KEY=your-public-firebase-app-api-key
   COMPANION_FIREBASE_SENDER_ID=123456789
   COMPANION_FIREBASE_CREDENTIAL_FILE=/run/secrets/companion-firebase.json
   ```

   Mapping: project ID and sender ID are `project_info.project_id` and
   `project_info.project_number`; app ID and API key are the matching client's
   `client_info.mobilesdk_app_id` and `api_key[0].current_key`. Restrict that API
   key to the Android package and the release signing certificate when applicable.
3. Give a dedicated service account the Firebase Cloud Messaging API Admin role
   (`roles/firebasecloudmessaging.admin`). Mount its JSON credential read-only
   at `COMPANION_FIREBASE_CREDENTIAL_FILE=/run/secrets/companion-firebase.json`;
   the account must belong to the configured project. This credential setting
   is required for delivery with either public-configuration method above.
   Keep it in the fleet credential store and outside the checkout. Pass the
   selected variables through the deployment's API environment and mount both
   configured files on that service. Firebase app configuration is returned to the authenticated phone;
   no project-specific config or service-account key is baked into the APK.
4. `PUBLIC_BASE_URL` must be the reachable HTTPS origin, without a path, query,
   userinfo, or fragment. Use a certificate trusted by Android. No TLS bypass is
   provided. Proxy both `/admin/companion/*` and `/companion/v1/*`; preserve SSE
   streaming and the Authorization header.
5. Deploy the API/frontend using the repository's regular deployment workflow.
   Migration `0039` is applied by the normal migration runner, never manually
   piped into MySQL. Enable the existing agent portal for chat.
6. Open **Account → Android devices → Pair Android device** in the dashboard;
   scan the five-minute QR in the app (or use **Paste pairing code** with its JSON
   payload), check the displayed server, and connect.
   Allow Android notifications. Under **Approvals**, review and approve a live
   host request. Sending an agent message automatically follows that conversation.

Without Firebase configuration, pairing, chat, and in-app approvals still work;
the dashboard and app explicitly report that push is not configured. Reopening
the app picks up newly configured Firebase identifiers and registers its token.

## Build and signing

Use JDK 17+, Android SDK platform 36, and the checked-in Gradle wrapper (9.4.1;
SHA-256 verified). AGP 9.2.1 includes Kotlin support; Compose compiler is 2.2.10.

```sh
cd mobile/android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. Release builds read
signing material only from the process environment:

```sh
export COMPANION_SIGNING_STORE=/absolute/path/companion-release.jks
# Read COMPANION_SIGNING_PASSWORD from the credential store or a protected file.
# Required alias: companion. Store and key passwords must match.
./gradlew :app:assembleRelease
unset COMPANION_SIGNING_PASSWORD
```

The signed APK is `app/build/outputs/apk/release/app-release.apk`; without signing
variables the release APK is unsigned. Keep the signing key for future updates.
Never commit it. `apksigner verify --print-certs` reports its SHA-1/SHA-256 signing
certificate fingerprints for Firebase. Distribution is by APK; no Play Store
upload or production rollout is part of the development build.

## Delivery behavior and operation

- Notifications contain identifiers and generic text only. The app authenticates
  to retrieve content and current approval state. Approval always happens in the
  app; no lock-screen approve button exists.
- `companion_notifications.state` records pending, sent, canceled, or failed.
  Pending jobs claim a one-minute retry lease; attempts are bounded at eight and
  backoff at five minutes. Expired jobs are canceled and purged a day later.
  An FCM acceptance means accepted by Google, not proof the phone displayed it.
- Approvals notify only after the CLI polls again (a live waiter), and expire with
  the existing five-minute request. Both desktop and phone lock the same request.
- Chat notifications expire after one hour. Questions/attention reach eligible
  devices; replies notify only followed conversations. Routine progress and
  session lifecycle events are silent. Foreground conversations suppress alerts.
- SSE runs only while the app is visible. Cursor-based resumption and idempotent
  sends handle reconnects; an unsuccessful send preserves its draft and retry ID.
- Devices expire after one year. Disabled admins, role changes, device revocation,
  and portal suspension are rechecked by the API; revocation terminates access
  on the next stream page. Revocation cannot recall a push already accepted by
  FCM. No chat history is persisted on the phone.
- If notifications stop, inspect Android notification permission/channel settings,
  Google Play services, server Firebase configuration, and outbox failed counts.
  The server never logs service-account keys, device bearers, or FCM tokens.

## Acceptance and rollback

### Opt-in live Firebase check

The instrumented `firebaseDeliversBackgroundApproval` test verifies actual FCM
delivery while the app is backgrounded, notification display, and opening the
approval review before an explicit approval. Its API is a local TLS fixture;
the Firebase registration and push transport are real. Use an emulator with
Google Play services and set `ANDROID_HOME` to its SDK directory.

Copy only the public Android configuration to the emulator:

```sh
adb -s emulator-5554 push /path/to/google-services.json /data/local/tmp/companion-google-services.json
```

Start the host sender from `api/` in one terminal; it waits up to three minutes
for the instrumented test and uses the production `FcmTransport` implementation:

```sh
ANDROID_SERIAL=emulator-5554 \
COMPANION_FIREBASE_CONFIG_FILE=/path/to/google-services.json \
COMPANION_FIREBASE_CREDENTIAL_FILE=/path/to/service-account.json \
npx tsx scripts/verify-companion-fcm.ts
```

Then run from `mobile/android/` in another terminal:

```sh
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.firebase=true \
  -Pandroid.testInstrumentationRunnerArguments.firebaseDelivery=true \
  '-Pandroid.testInstrumentationRunnerArguments.class=io.uggs.orchestrator.CompanionUiTest#firebaseDeliversBackgroundApproval'
```

The host reads a short-lived token fixture through `adb run-as`; the test removes
it on completion. No service-account credential or OAuth bearer is copied to the
emulator or logged. The sender's FCM acceptance and the Android test must both
pass. The ordinary CI run skips these Firebase-dependent tests.

### Final acceptance

Run API unit/type/lint/build checks and real-MySQL integration tests, frontend
checks and the `admin-companion` browser test, Android lint/unit/build checks,
and Android instrumented UI tests. Final live acceptance requires a physical
phone and configured Firebase: pair → background → receive a host request →
approve → observe the waiting CLI proceed; then message an agent and receive its
reply notification. Emulator tests and mocked FCM transport do not replace this.

To disable a phone, revoke it in Account. To stop outbound delivery, remove the
Firebase credential configuration and restart the API during an authorized
rollout. Reverting the application build leaves the additive companion tables
available for a later re-upgrade; no destructive down migration is needed.
