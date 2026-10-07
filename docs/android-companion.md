# Android companion

The app is **Orchestrator**, package **`io.uggs.orchestrator`**, Android 8 or newer.
It connects to one orchestrator at a time; each phone is independently revocable.
Google Play services are needed for FCM, but chat and approval review work without
push. No Analytics SDK is included.

## On-the-move interface

**Now** shows live host requests and reachable agents needing a reply first, then
other agents whose server-reported `relay_ready` is true. Offline, ended, idle
without a receiver, and read-only sessions are omitted. Unread replies do not bring
old sessions back into the list; a retained notification can still open read-only
history. A working agent appears
only if its receiver can still accept a message. Project name, host, and engine
identify each conversation; **Review next** opens the next decision directly.
Each row also shows the agent's latest short summary (one sentence, at most
160 Unicode characters, displayed on up to two lines). An open question or active
attention notice takes priority over the last reply. The full answer stays in chat.
The compact layout uses flat chat rows, circular avatars, and at least 48 dp
action targets while respecting Android text size settings.

Host decisions use a bottom sheet with requesting host/IP, expiry, duration
presets, and large **Deny** / **Allow** buttons. Requests are rechecked by the
server; expired requests and connection snapshots older than 30 seconds cannot
be acted on. Chat shows messages and the current question, with direct option
buttons; status/lifecycle events stay off the mobile timeline. Sending follows
replies automatically. Connection, alert controls, and confirmed sign-out live
under **More**. Desktop retains the full session inventory and administration.

## Live updates

Version 0.3.0 keeps one foreground WebSocket at `/companion/v1/ws` for overview,
approvals and the open chat. `hello` starts a full refresh; `changed` carries a
`scopes` array (`me`, `agents`, `approvals`) and triggers the corresponding REST
reads. Chat resumes from its last durable event cursor. The socket carries no
transcript content or admin event payloads. The existing SSE endpoint remains
available to older APKs.

Server changes invalidate immediately; one shared five-second reconciliation
also catches expired requests and lost agent readiness. Authorized heartbeats
arrive every 15 seconds. The app stops showing Live after a lost connection or
30 seconds without a frame, reconnects with a 1–30 second backoff, and reconciles
before enabling actions again. Refreshes are serialized and stale responses are
discarded. Backgrounding closes the socket; FCM continues to deliver notifications.
The visible conversation is renewed every 20 seconds for push suppression.

The socket uses the paired device's Bearer header, rejects browser-origin
requests, rechecks current permissions, and closes on revocation or the global
API kill switch. It is independent of `ADMIN_WS_ENABLED`. Deploy the API supporting
this endpoint before installing 0.3.0; roll out wrapper 0.9.17 for authored summaries.

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
   userinfo, or fragment. Use a certificate trusted by Android. For the fleet
   endpoint `codex-auth.uggs.io` only, the app also accepts CAs explicitly installed
   in Android's user certificate store. All other hosts use system CAs, and
   certificate/hostname verification remains enabled everywhere. No TLS bypass
   is provided. Proxy both `/admin/companion/*` and `/companion/v1/*`; preserve WebSocket
   upgrades, SSE streaming for older apps, and the Authorization header.
5. Deploy the API/frontend using the repository's regular deployment workflow.
   Migration `0039` is applied by the normal migration runner, never manually
   piped into MySQL. Enable the existing agent portal for chat.
6. Open **Account → Android devices → Pair Android device** in the dashboard;
   scan the five-minute QR in the app (or use **Paste pairing code** with its JSON
   payload), check the displayed server, and connect.
   Allow Android notifications. On **Now**, review and approve a live
   host request. Sending an agent message automatically follows that conversation.

Without Firebase configuration, pairing, chat, and in-app approvals still work;
the dashboard and app explicitly report that push is not configured. Reopening
the app picks up newly configured Firebase identifiers and registers its token.

## Appearance and conversation layout

Version 0.4.4 gives the home screen a WhatsApp-inspired layout: a compact green
**Orchestrator** header, rounded **Search chats** field, **All**, **Unread**, and
**Needs you** filters, and full-width chat rows. Each row shows its circular engine
avatar, project name, timestamp, host identity, short summary and a small unread
number. The palette follows Android light/dark mode and the rows grow with system
font scaling. **Review next** floats at the bottom when a decision is available;
the list leaves room so it does not cover the last chat.

Search and filters operate only on the already-authorized overview; they never
fetch a transcript, acknowledge a reply, or change notification follows. Live
host approvals remain visible through chat filters. The redesign is Android-only
and uses the existing 0.4.3 API. No server rollout is required.

Version 0.4.0 follows the Android light/dark setting with blue accents, soft surfaces,
rounded controls and a compact, top-aligned conversation list. Host reviews and
agents needing a reply come first. Rows show project, host/engine and the existing
short summary. Version 0.4.3 places a compact unread reply number on each session.

Version 0.4.1 replaces project initials and the written engine name with bundled
Codex, Claude and Grok vector marks, in both the list and chat header. A small
computer badge shows the short host name; TalkBack retains the full host and
engine names. Missing hosts have no badge and unknown engines use a terminal
symbol. Marks adapt to light/dark mode and load entirely from the APK; their
pinned source and license are included with the Android resources/assets.

Chats place your messages on the right in blue and agent replies on the left.
Consecutive messages from one sender group within five minutes on the same local
day. Day separators and group timestamps use server event times; legacy messages
without valid timestamps do not invent a time. Text remains selectable, wraps to
85% of the chat width, and respects system font scaling. The rounded composer
grows to four lines above the keyboard. While reading older messages, incoming
replies leave the reading position intact and offer **New messages** to jump back.
Pairing, settings and host-access sheets share the same theme and 48 dp targets.

The 0.4.0 and 0.4.1 appearance updates are Android-only: existing 0.3.0
REST/WebSocket/push contracts and permissions remain unchanged. Agent-authored summaries still require wrapper
0.9.17 or later in the running agent session. No server rollout is required.

## Unread replies and launcher badges

Version 0.4.3 introduced one **Sessions** list below live decisions; 0.4.4 uses flat
chat rows, with a small unread reply number at the trailing edge
(visually capped at `99+`, with the full count
available to TalkBack). There is no separate unread section or repeated **New**
label, and unread state does not promote ended/offline sessions into the list.
Cached reachable sessions remain visible while reconnecting; sending still
requires a fresh connection and an available receiver.

The authorized `/agents` snapshot exposes `reply_cursor`, the latest actual
`assistant_message` event cursor, independently of the summary/attention preview.
The app uses the read-only `POST /agents` snapshot with up to 500 local
`read_cursors`. Its `unread_reply_count` counts only retained assistant replies
after each session's cursor, so global event-ID gaps, progress, and other sessions
do not inflate the number. The server does not persist these client watermarks.
New replies create unread state even when no push was sent or the conversation
was already open. Progress, question changes, user messages and preview edits do
not. On first installation of this version, retained existing replies are unread
until viewed. Reading is acknowledged only while the resumed chat is authorized,
the list has settled at its bottom, and the latest actual reply is rendered and
visible. Opening the chat, fetching its events, or reading older scrollback does
not clear unread. If progress fills the event tail, the app fetches the last
advertised reply explicitly before allowing a read receipt.

Only hashed pairing identity, session identifiers, read/latest cursors and counts are
persisted locally, with bounded temporary identifiers for older cursorless pushes.
No transcript or summary is stored. State survives process restarts, is isolated
between pairings, and is pruned when authorized retention removes a conversation;
sign-out or revocation clears it. In-flight snapshots cannot erase newer pushes.
Transcript permission loss hides the unread overview and removes reply badges.

Reply alerts use a separate private notification channel with badges disabled.
Overview snapshots update only the silent aggregate badge; they never create a
separate alert for every existing unread session. Only a real incoming reply push
creates a reply alert, and upgrading removes the older synthetic history alerts.
A silent count notification supplies the launcher unread-conversation count and
opens Now; reading the reply removes its alert and updates that summary. Android
notification permission, channel settings and device notification opt-out are
respected. Launcher dots/counts depend on the installed launcher and its settings,
as described in [Android notification badges](https://developer.android.com/develop/ui/views/notifications/badges).
The in-app unread indicators work without Firebase or notification permission.
Attention and host-approval notifications retain their independent behavior.
The count notification is an ordinary notification: Android's
[Launcher3 excludes group headers](https://android.googlesource.com/platform/packages/apps/Launcher3/+/refs/heads/main/src/com/android/launcher3/notification/NotificationListener.java)
from launcher badges, so a group-summary flag would hide the dot.

Deploy the API exposing the read-only `POST /agents` snapshot and
`unread_reply_count` before installing 0.4.3. These fields are additive, require no migration, and are
redacted without transcript permission; existing APKs continue to work.

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

- Agent notifications contain identifiers and the source event's short summary;
  full replies are retrieved only inside the authenticated app. FCM therefore
  carries that summary. `agent_receiver_reply(..., summary)` and `cxx portal
  say/ask --summary` supply it in the reply's language. Missing summaries produce
  a neutral notice, never an excerpt of the full answer or a previous reply.
  Outbox retries retain the summary of their triggering event even if newer
  replies arrive. Notifications remain private on the lock screen and expand to
  show the complete summary. Host approvals retain their generic notification
  text and always require review in the app.
- `companion_notifications.state` records pending, sent, canceled, or failed.
  Pending jobs claim a one-minute retry lease; attempts are bounded at eight and
  backoff at five minutes. Expired jobs are canceled and purged a day later.
  An FCM acceptance means accepted by Google, not proof the phone displayed it.
- Approvals notify only after the CLI polls again (a live waiter), and expire with
  the existing five-minute request. Both desktop and phone lock the same request.
- Chat notifications expire after one hour. Questions/attention reach eligible
  devices; replies notify only followed conversations. Routine progress and
  session lifecycle events are silent. Foreground conversations suppress alerts.
- WebSocket runs only while the app is visible. Cursor-based resumption and idempotent
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
