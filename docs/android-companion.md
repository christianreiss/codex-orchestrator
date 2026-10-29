# Android companion

## Foundation (Android 0.5.12)

Internal release preparing the chat redesign. `CompanionModel` remains the facade
screens and tests use; its state now lives in slices (`CompanionLive`,
`DirectHistory`, `DirectChatSend`, `ChatUploads`, `ChatCacheWriter`, `UnreadState`,
`QuotaState`, `AccessRequests`). `ChatDomain.kt` defines `ConversationKey`
(`Direct` | `Room`), `MessageKey` (`PortalEvent` cursor | `RoomEvent` UUID) and a
`ChatMessage` shared by direct chats and rooms, with mappers from both wire formats.
Libraries: Compose BOM 2026.06.01 (newer BOMs require compileSdk 37),
navigation-compose 2.9.8 and core-splashscreen 1.2.0 are dependencies but not yet
wired. Test tags and behavior are unchanged. APK-only; no API rollout required.
Verification: 82 JVM tests, lint, debug build and androidTest compilation passed;
emulator UI tests were not run.

## Chat agent indicators (Android 0.5.11)

Direct-chat rows show a green **Online**, amber **Working**, or gray **Offline**
indicator with a text label. Activity expiry or a stale/disconnected app snapshot
shows **Unknown**, never a cached live claim. Native activity takes precedence over
legacy presence; waiting agents remain online and show **Waiting for you**.
Receiver readiness remains separate from work status. Existing active-chat filters
are unchanged. APK-only; no API rollout required.

## Shared read state (Android 0.5.10)

Agent conversation read positions now synchronize across devices paired to the same
administrator. A visible reply advances the local watermark immediately and queues
an opt-in `sync_reads:true` agents snapshot; failed uploads retry on reconnect from
persisted local markers. A persistent pending-receipt queue drains in batches of 500; `processed_read_cursors` settles each submitted batch independently of the authoritative `read_cursor`. Unknown or rejected positions do not cause refresh loops. Only real authorized assistant event positions advance the
server watermark; older devices and out-of-order snapshots cannot move it backward.
Returned `read_cursor` values merge into each device ledger before unread counts.
Newer replies remain unread, and delayed old pushes cannot resurrect a cleared badge.
Rooms already share administrator read positions; read advances now invalidate other
connected views. No message bodies are stored in read state.

Requires the API with migration 0108. `/me` advertises the protocol; older servers
retain device-local behavior. Push registration advertises protocol 1, so only new
APKs receive silent read pushes. These remove existing badges without showing a new
notification; unavailable/offline push converges on the next authenticated snapshot.

## Android engine quotas (0.5.9)

`GET /companion/v1/quotas` uses the paired-device Bearer token and requires
`admin.read` and `auth.read_metadata`, rechecked before returning the snapshot. It returns `engines` for
Codex, Claude and Grok, each with `engine`, `label`, `enabled` and `accounts`.
Each account exposes only `id`, `label`, `state`, `fetched_at`, `stale`, and
`windows` (`kind`, `used_percent`, `resets_at`, `limit_seconds`). Removed accounts
are excluded. Codex/Claude retain short and weekly windows; Grok retains its
current weekly/monthly window. Suspended engines remain readable as snapshots.
The read makes no provider call, account-maintenance change or credential read.

Android shows the Quotas tab to users with both read capabilities, refreshes on entry,
every 60 seconds while visible, and manually. Snapshot age over ten minutes,
expired reset times and server-marked stale readings show Stale; missing windows
show Unavailable, never zero. Times use the device timezone. Connection loss or
refresh failure leaves the last snapshot visibly marked; quota data is not
persisted. Older servers return 404 and the tab explains that an update is needed.
API rollout is required before installing the APK to use this tab.


## Member presence in rooms (0.5.6)

Rooms show a member strip above the timeline and use the same avatars in Details.
Each avatar is the engine icon with a presence badge: working (amber), listening
(green), idle (blue) or offline (hollow ring). The state is also written under the
name and spoken by accessibility services, so colour is never the only signal.
Presence follows the Chats rules: a member counts as online only when its session
is a listed agent that is not closed, not read-only and listening, working or idle,
**and** the roster says `reachable: true`. Without an agent overview the roster flag
alone yields "Available". This APK-only change needs no server rollout.

## Read markers in rooms (0.5.7)

Under the newest message each agent has been shown, the timeline lists those agents
("Read by Anna, Bob") with their engine icons. The position is the server's
`read_through` per room member: the newest room event time returned to that agent
by `chats/read`. It only moves forward, so reading older history never moves it back.
Agents that never read the room, or whose position lies before the loaded history,
show no marker.

What counts as read: only an explicit `chats/read` by the agent (MCP `agent_chat_read`,
bridge route). A message delivered to an agent as a direct request or group
publication is **not** a read of the room; its delivery status stays under the message.
Operator reads, including the app's own, never move an agent's position.

Precision: room events carry one-second timestamps, so a position covers every
message of the second the agent read in. A message sent in that same second can
show as read although the agent did not see it.

The server change must be deployed first: it adds migration 0106
(`agent_room_agent_reads`) and the `read_through` member field on every room read.
Older servers omit the field and the app then shows no markers; presence badges
(0.5.6) keep working. Live updates reuse the existing `agent_room_chat.changed`
frame, sent only when an agent's position actually advances.

## Resolved host reviews (0.5.5)

An open host-access review closes automatically when a fresh approval snapshot
shows that the request was allowed or denied elsewhere, removed, or expired.
While disconnected it stays open with disabled actions until a fresh snapshot
arrives. Local Allow and Deny still close the review after a successful decision.
This APK-only change needs no server rollout.

## Active conversations (0.5.4)

Rooms now apply the Chats rules to their members: a member counts only if its
`session_id` belongs to an agent the Chats tab would list as online (not closed,
not read-only, presence `listening`, `working` or `idle`) **and** the roster says
`reachable: true`. The roster flag alone only means a fresh heartbeat. Without an
agent overview (no transcript permission) the roster flag is used as before.

## Active conversations (0.5.3)

The Active directory requires at least one online agent. Direct chats use live
session presence; groups, conferences and scope rooms require a remaining member
with `reachable: true` in the server roster. Empty and entirely offline rooms,
and offline/ended direct chats with urgent notices, are hidden from Active.
Category tabs use the same filtered list and fall back when the last visible room
disappears. History continues to show retained closed conferences without an
online-member requirement. This APK-only change needs no server rollout.

## Conference history (0.5.2)

Adjourned conferences move out of Active once every retained member is offline.
History in the conversation header opens the retained conference directory;
Active returns to current chats. Both views paginate independently and preserve
room messages and drafts. The server change also cleans existing conferences
for older APKs; the History button requires 0.5.2.

## Conversation categories (0.5.1)

The conversation list uses one compact segmented control: Chats, Groups and
Conferences. Only categories with loaded entries appear; search does not hide
tabs. Selection falls back to the first available category when its entries
disappear. Groups also contains project and host rooms. Status/unread filter
buttons and redundant list headings are removed; unread badges remain.

## Shared conversations and mobile design (0.5.0)

Chats combines direct messages with groups, conferences and project/host rooms.
Search works across their titles and descriptions. Groups and Conferences filters
do not mix private conversations into their results; More conversations loads older
directory pages. Version 0.5.1 replaces these filters with the categories above.

Room messages show their author, local time, Markdown and attachments. Earlier
messages use the server's opaque cursor. Each room keeps its draft, upload intent
and selected answer recipient while switching. Sharing is passive by default;
Ask an agent or Ask the room explicitly requests answers. Delivery receipts expose
unreachable/old-wrapper reasons instead of claiming a reply. Uncertain sends reuse
the original UUID and payload; definitive validation/permission failures let the
operator correct the draft. Reading marks only a rendered latest message as seen.

New creates a group or a one-hour conference. The participant picker supports
search. Details lists participants and their readiness; authorized operators can
invite/remove members or end a conference with confirmation. Pending operations
retain their original UUID after a lost response. The server remains authoritative
for membership, permissions and conference draining.

The design uses one neutral light/dark surface system, blue interaction accents,
16 sp conversation text and minimum 48 dp interactive targets. Direct outgoing
messages use the shared primary-container color. Navigation remains Chats, Hosts,
Authorizations; this is a native task-oriented companion, not a copy of all admin
configuration screens.

Hosts, Authorizations and all bottom sheets reuse the Chats building blocks in
`CompanionTheme.kt` (`searchFieldColors`, bordered cards, `SectionHeader`,
`EmptyState`, `StatusDot`, `SheetShape`), so the three tabs share field, card,
empty-state and sheet styling. Presentation only; behaviour and test tags are unchanged.

The additive Companion room routes must be deployed before use. Older servers
return an unavailable shared-room state while direct chats continue working. Room
content requires `agent_messaging.reveal_content`; mutation additionally requires
`agent_messaging.manage`. Device revocation and capability changes clear private
room state. Room uploads use the existing encrypted attachment service and draft
ownership checks. Live `rooms` frames contain no message text and are permission
filtered. Room history/drafts are currently retained in memory for the foreground
app lifetime; background room FCM subscriptions are not added in this release.
Existing direct-chat FCM behavior remains unchanged.

Verification on 2026-10-18: 55 JVM tests and 48 emulator UI tests passed; two
Firebase delivery tests were skipped because their external configuration was
absent. The two room flows also passed in dark mode at 1.3 font scale. Android
lint/build and API typecheck/build passed; the API suite passed 5,165 tests with
785 skipped. No new database-backed suite or physical-device installation was
run for this release. The locally produced APK is debug-signed; production
signing and on-device update compatibility have not been verified.

## Authorizations tab (0.4.17)

Navigation is **Chats · Hosts · Authorizations**. The third tab requires
`hosts.activate_insecure`; its badge counts live, unexpired requests. Pending
host-access requests now appear here instead of in the chat list. Review retains
the existing duration choices and Allow/Deny sheet. **Review next** and approval
notification links select this tab before opening the request.

**Active windows** lists every insecure host with an unexpired grant, including
hosts without a daemon, alongside any open fleet window. Rows show the deadline
and remaining time. **Close** uses the existing single-host disable operation,
clears its grace tail and blocks automatic session renewal. While a fleet window
is open, host Close is disabled because fleet access would immediately reopen it.
Matching active domain grants are identified with a warning that they can reopen
a disabled host on its next request; managing those rules remains in the WebUI.

**Close fleet window** requires confirmation: this closes all host windows and
active domain grants, including permanent domain allows. It preserves the
existing fleet service's retry and concurrent-reopen semantics. If a concurrent
reopen wins, the app refreshes instead of claiming the new window was closed.

Actions require a fresh connection and are disabled while another mutation is
pending. Offline rows are marked as possibly stale. Deadlines expire locally;
WebSocket invalidations and server deadline notifications update grants,
external decisions, closures and permission changes without opening chats or
changing unread state. Errors retain the window and allow refresh/retry.

Deploy the additive `/approvals` window projection and both Companion close
routes before installing 0.4.17. No migration is required; previous APKs continue
using the existing response fields. This feature does not add manual window
opening or domain-grant management to Android.

## Reconnecting after the rich-chat server upgrade

If the phone authenticates but stays on **Reconnecting…**, a server-side chat
snapshot failure can close its WebSocket with code 1013. Migration `0058` repairs
the rich-chat tables' `session_id` columns to match the existing `agent_sessions.id`
charset and collation. This prevents MySQL's **Illegal mix of collations** error
on installations whose database default differs from older Portal tables.
Apply it through the normal migration runner; chat data and device pairing are
preserved. The existing APK reconnects automatically after the repair.

## Hosts and remote conversations (0.4.10)

Chats remains the default. Hosts lists daemon-enabled hosts, sorted by availability,
with search, free slots, supported engines and an explicit reason when starting is
unavailable. Starts require a fresh foreground connection. Codex is selected if
ready, otherwise Claude or Grok. The sheet accepts an optional task, title and
absolute working directory; an empty task establishes contact only. The agent
publishes its real greeting and subsequent results/questions through Portal.

Device-bearer routes `GET /companion/v1/hosts` and
`POST /companion/v1/daemon-sessions` expose this entry point. The start body is
`{host_id, engine, client_message_id, task?, title?, cwd?}`; the 202 result contains
`operation_id` and the durable logical `session_id`. Listing needs `admin.read`;
starting also needs `agent_messaging.manage`, `agent_portal.read`,
`agent_portal.manage` and `agent_portal.reveal_transcript`. Readiness and capacity
are rechecked under the daemon lock. No daemon settings are changed by the app.

The server projects owned remote sessions through the existing `/agents` routes,
with `daemon_session:true`, `remote_status` and `portal_session_id`. Their `id` is
the logical daemon UUID. Each native run is linked by
`host_daemon_portal_bindings`; events and unread reply counts span those bindings.
Sending while idle/waiting resumes the same native transcript; missing transcripts,
closed/failed/unknown sessions and occupied hosts reject continuation. A repeated
UUID returns the original operation, including after acceptance. Live ordinary
Portal messages still use the normal receiver. Completed daemon launches retain
open Portal questions for explicit answers through a native resume.

Queued, running and stopping remote conversations show **Offline** when the daemon
loses its fresh connection, unless the bound agent still has a usable Portal relay.
This changes displayed presence only: the persisted `remote_status` and unresolved
work outcome remain available for reconciliation. A busy but connected daemon
continues to show active work.

At completion, authenticated headless output supplies the native transcript ID
even when the receiver ended before reporting it. The server persists it on the
bound mailbox and Portal launch; conflicting bindings reject that completion.

`companion_daemon_follows` exists before the first Portal registration, then copies
the follow to every bound launch. Push targets the logical UUID and suppresses
notifications while that conversation is visible. No greeting is fabricated in
the app. Pending starts are persisted in Keystore-encrypted storage before sending;
Retry uses the original body and UUID after an interrupted response or app restart.
The new `hosts` WebSocket invalidation scope is metadata-only and permission gated.
Existing APKs and ordinary conversations retain their routes and behavior.

`RemoteLiveTest.contactAndFollowupUseTheSameNativeTranscript` is an opt-in live
acceptance test. Supply `-e livePairingPath /data/local/tmp/companion-live.json`
to Android instrumentation. The protected, disposable fixture contains
`{pairing:{version:1,server,token},host,host_id}` and explicitly selects the host.
It starts contact through Hosts, waits for the actual greeting, sends a harmless
follow-up through the composer and verifies the same native transcript and both
real assistant replies. It revokes its test device and clears app credentials.
Its credential-free result is `files/live-remote-proof.json` in the debug app.
This checks the remote conversation; physical FCM acceptance remains separate.

The legacy `/go` magic-link webchat is removed. Active Clients and Android
continue using the existing session/receiver contracts and `cxx portal` commands;
operator access requires a dashboard account or its paired device. Session
settings and remote-session controls are available in Active Clients.

The app is **Orchestrator**, package **`io.uggs.orchestrator`**, Android 8 or newer.
It connects to one orchestrator at a time; each phone is independently revocable.
Google Play services are needed for FCM, but chat and approval review work without
push. No Analytics SDK is included.

## On-the-move interface

Chats retain the server-provided history, including offline and ended conversations.
The default **All** filter shows online, active agents across all engines:
listening, working and idle sessions, plus chats with unresolved important,
critical or blocker notices, including offline/ended or read-only chats.
**Unread** and the activity filters narrow this same list; there is no separate
important/Needs you filter. Hiding a row does not delete its conversation or
change read markers. Unread reply counters are red for chats with unresolved
classified notices and green otherwise; the exact reply count is unchanged.
Server history lasts for the session lifetime plus 24 hours by default. Closing
the app or losing agent connectivity does not remove the conversation. Closure
still clears unread counters and reply alerts; delayed pushes cannot recreate them.
This uses the existing server projection and requires no API rollout.

Outgoing messages appear immediately with **Sending…**, including in an empty
conversation. Server confirmation changes that to **Queued**; later receipts
retain the existing delivered/read/working states. An unconfirmed request keeps
its bubble and draft with **Retry**, which reuses the same operation ID. The
server event replaces the local bubble by confirmed message ID, never by matching
text. Pending bubbles survive conversation switches in the running app and do
not advance server history or unread cursors.

Live host requests and reachable agents needing a reply remain actionable through
**Review next**. Sending requires fresh server-reported receiver readiness;
offline and ended chats remain readable. Session name, host, working
directory, and engine identify each conversation; **Review next** opens the next decision directly.
Each row also shows the agent's latest short summary (one sentence, at most
160 Unicode characters, displayed on up to two lines). An open question or active
attention notice takes priority over the last reply. The full answer stays in chat.

Questions backed by a native receiver expire on the next server maintenance sweep
when that receiver stops or has no fresh heartbeat for 45 seconds, even if the
wrapper remains connected. A recovered receiver, armed reboot handoff or durable
Companion Remote answer path preserves the question. Expiry does not close the
conversation or resolve classified notices.

The compact layout uses flat chat rows, circular avatars, and at least 48 dp
action targets while respecting Android text size settings.

Host decisions use a bottom sheet with requesting host/IP, expiry, duration
presets, and large **Deny** / **Allow** buttons. Requests are rechecked by the
server; expired requests and connection snapshots older than 30 seconds cannot
be acted on. Chat shows messages, classified notices and the current question, with direct
option buttons; status/lifecycle events stay off the mobile timeline. Notices
use their event timestamp and remain highlighted after resolution with a Resolved
label. An unresolved notice outside the loaded history appears once from its
overview summary; its preview never advances a read cursor. Sending follows
replies automatically. Connection, alert controls, and confirmed sign-out live
under **More**. Desktop retains the full session inventory and administration.

## Live updates

The app holds one authenticated WebSocket while visible. New agents, agent exits,
activity changes, direct replies and room messages trigger server-pushed scope
invalidations and automatic authorized reads; no manual refresh or periodic app
list polling is needed. In the background Android uses FCM instead of holding an
unbounded socket. Returning to the app or reconnecting always reloads a complete
authorized snapshot and resumes the selected transcript from its event cursor.

Version 0.4.12 completes in-flight refreshes even while further agent/host
metadata invalidations arrive, then reads the queued changes. This prevents busy
fleets from leaving chat history empty, replies unseen or host readiness stale.
Permission changes, connection generations and conversation switches still fence
superseded responses. This APK fix uses the existing server API.

Version 0.4.5 presents the first connection attempt as **Connecting…**, with a
quiet **Loading your chats…** indicator on an empty home screen. Returning from
the background uses the same calm state while refreshing. A real failure or lost
socket immediately shows **Reconnecting…** and retry controls, including when
the app has never connected successfully. Actions stay disabled until the usual
authorized, fresh snapshot is complete; drafts and cached chats are preserved.
This presentation-only APK update needs no server rollout.

Version 0.3.0 keeps one foreground WebSocket at `/companion/v1/ws` for overview,
approvals and the open chat. `hello` starts a full refresh; `changed` carries a
`scopes` array (`me`, `agents`, `approvals`, `hosts`, `rooms`) and triggers the corresponding REST
reads. Chat resumes from its last durable event cursor. The socket carries no
transcript content or admin event payloads. The existing SSE endpoint remains
available to older APKs.

Server changes invalidate immediately; owner presence and deadline notifications
also catch expired requests and lost agent readiness. Transport heartbeats
arrive every 15 seconds. The app stops showing Live after a lost connection or
30 seconds without a frame, reconnects with a 1–30 second backoff, and reconciles
before enabling actions again. Refreshes are serialized; responses superseded by
permission, connection or conversation changes are discarded. Metadata changes
queue a follow-up refresh without discarding the completed snapshot.
Daemon health changes invalidate both host cards and remote conversation cards,
including heartbeat expiry without a new session event. Each scope retains its
own permission check, so conversation presence also refreshes for devices without
host-list access.
Backgrounding closes the socket; FCM continues to deliver notifications.
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
   piped into MySQL. Enable **Agent sessions** in Active Clients for chat.
6. Open **Account → Android devices → Pair Android device** in the dashboard;
   scan the five-minute QR in the app (or use **Paste pairing code** with its JSON
   payload), check the displayed server, and connect.
   Allow Android notifications. On **Now**, review and approve a live
   host request. Sending an agent message automatically follows that conversation.

Without Firebase configuration, pairing, chat, and in-app approvals still work;
the dashboard and app explicitly report that push is not configured. Reopening
the app picks up newly configured Firebase identifiers and registers its token.

## Appearance and conversation layout

Version 0.4.14 extends the Chats palette to conversations in light and dark mode.
Own messages use green bubbles over a warm neutral (dark: charcoal) background;
photos, captions, timestamps and delivery receipts stay inside each bubble. Tap a
photo to open the full image; its overflow menu offers Save. Long-press a message
for Reply or Copy (also available as TalkBack actions). Reply quotes show the
original sender and retained text, with an attachment fallback for media-only
messages and an explicit unavailable preview for expired history. The composer
shows the selected quote with a cancel button before sending the same event reference.

The rounded input has an attachment button and a camera shortcut when empty,
with a separate round Send button. Sending no longer overlays the input with a
redundant Sent snackbar; the bubble and delivery receipt provide confirmation.
The attachment sheet offers Photos, Camera,
Video, Audio and Document. Selected photos show thumbnails, upload progress and
remove/retry controls above the input. An incoming button-only question, or its
removal, preserves an active voice recording and pending camera capture.
Drafts, upload IDs and receipt semantics
use the existing 0.4.13 API. No server rollout is required.

Version 0.4.8 reads the server-assigned `launch_name` and displays
`(Claudia) Release review` in the chat list, chat header and search. A launch
without a task title still shows `(Claudia)`; an already-prefixed server title
is not prefixed twice. German umlauts and JSON null fields are handled as usual.
Older unnamed sessions retain their native title or short session-ID fallback.
Native resumes preserve the original agent name when available; names remain
reusable after the server's 24-hour quarantine. A reused-name conflict stops
resume explicitly. Conversation actions keep using their stable session IDs.
The task title remains restricted to devices with transcript permission.

Version 0.4.7 shows the **native session name** as the main row title and chat
header. Host and full working-directory path appear in a smaller second line;
the short summary remains on a separate line. Search includes the name, host,
directory and summary. Missing names use **Session <short native ID>**, or the
short orchestrator ID before native binding, so same-project chats remain distinct.
Explicit JSON null values are treated as missing on the Android runtime.
Long paths and names wrap/truncate within the row; TalkBack retains the text.

Wrapper 0.9.32 reads only the bound session's naming metadata: Codex's
`session_index.jsonl` (`thread_name`), Claude's `custom-title` records, and Grok's
`summary.json` title/generated title. It polls on the receiver's 15-second cadence,
reports only changes, and retries each encrypted `session_named` event with the
same ID and payload. Naming failures do not stop reception. No transcript text is
used by this metadata reader to invent a title. For an unnamed session, fleet
startup guidance tells the AI to call `agent_session_name` with a concise name
in the operator's language on its first turn, before its first response, even when
that turn is only a question. The tool sets only a missing name, atomically preserving
an existing native/AI name even during concurrent calls. A later native rename
supersedes the AI fallback. Names are bound to the native conversation; switching
conversations hides the old name and allows the AI to name the new one. Until the AI's next turn names it, the short ID stays
visible. The companion's GET/POST overview exposes `session_name`
only with transcript permission; names create neither reply counts nor push
alerts. Deploy the API accepting this additive event and update wrappers before
installing 0.4.7. Old wrappers/APKs remain compatible; there is no schema migration.

Version 0.4.4 gives the home screen a WhatsApp-inspired layout: a compact green
**Orchestrator** header, rounded **Search chats** field, **All**, **Unread**, and
**Needs you** filters, and full-width chat rows. Each row shows its circular engine
avatar, timestamp, short summary and a small unread
number. The palette follows Android light/dark mode and the rows grow with system
font scaling. **Review next** floats at the bottom when a decision is available;
the list leaves room so it does not cover the last chat.

Search and filters operate only on the already-authorized overview; they never
fetch a transcript, acknowledge a reply, or change notification follows. Live
host approvals remained visible through chat filters in 0.4.4; 0.4.17 moves them
to Authorizations. The 0.4.4 redesign used the existing 0.4.3 API without a server
rollout.

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

The original 0.4.0 layout placed your messages on the right in blue and agent
replies on the left.
Consecutive messages from one sender group within five minutes on the same local
day. Day separators and group timestamps use server event times; legacy messages
without valid timestamps do not invent a time. Text respects system font scaling;
0.4.14 uses up to 88% of the chat width and
provides Copy through the message menu. The rounded composer
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
label. Offline and ended sessions are excluded from **All** while their retained
history remains available to existing conversation and notification links.
Cached online sessions remain visible while reconnecting; sending still
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
between pairings, and is pruned when authorized retention removes a conversation.
An authorized closure clears its count and pending alerts without advancing the
read cursor, and ignores delayed reply pushes while the session remains closed;
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
- Chat notifications expire after one hour. Ordinary questions and replies notify
  followed conversations. Explicit important/critical/blocker notices reach eligible
  devices regardless of follow state. Routine progress and
  session lifecycle events are silent. Foreground conversations suppress alerts.
- WebSocket runs only while the app is visible. Cursor-based resumption and idempotent
  sends handle reconnects; an unsuccessful send preserves its draft and retry ID.
- Devices expire after one year. Disabled admins, role changes, device revocation,
  and portal suspension are rechecked by the API; revocation terminates access
  on the next stream page. Revocation cannot recall a push already accepted by
  FCM. From 0.4.16, the bounded active-chat cache described below persists
  previously authorized history on the phone.
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

## Outgoing instruction receipts (0.4.9)

Every outgoing bubble shows Queued, Delivered to agent, Read by AI, AI is working,
or Replied. Not delivered/canceled remains explicit. Read/working require an explicit
`agent_receiver_status` report from cxx 0.9.43; message acceptance alone only proves
delivery to the agent bridge. Working also requires a fresh snapshot and matching
active turn; offline or newer turns retain the historical read receipt. Replies must
name that message ID. Older hosts remain at delivered until a correlated reply arrives.
Receipt events do not generate push notifications or release the operator instruction.

## Agent chat in Android 0.4.13

Chats use the existing paired operator/daemon identity and history. Questions support buttons, text or both; button labels may differ from stable answer values. From 0.4.18, important, critical and blocker notices appear as red-highlighted messages in the regular chat timeline, with a severity label and one Resolve action per unresolved notice. An unresolved notice stays visible for offline/ended agents; viewing or answering never clears it.

Attach files/photos through Android's document picker, capture a photo/video, or record audio after microphone permission. Uploads show progress and support cancel/retry with the same upload ID. Defaults are ten files, 100 MiB/file, 250 MiB total and 15 minutes per recording. Incoming pictures have a full-image viewer; audio/video play locally and files can open in another installed app. Automatic local ASR and video frames are prepared by the server worker for agent inspection. Failures retain the original. Drafts and upload intent survive switching conversations; confirmed sends clear their own draft and attachments. Agent replies render native Markdown text/code and offer Copy/Reply with an event reference. No Pixel installation was performed for this release.

## Saved active chats (0.4.16)

Recently opened, unfinished conversations retain confirmed server events locally,
including receipt events used by message bubbles. Progress chatter is omitted while
its server cursor is retained for resumption. Reopening a chat or starting the
app offline shows saved history immediately. A saved-content banner remains until
an authorized server refresh succeeds. The existing WebSocket invalidations fetch
new events after the cached cursor; repeated server rows replace the cached row
with that cursor. Cached content never enables sending, establishes live activity,
creates unread notifications or acknowledges an unseen reply.

The cache holds at most 20 conversations, 500 events per conversation and 4 MiB in
total. It lives in backup-excluded private app storage, uses AES-GCM with Android
Keystore, and is scoped to server, device and pairing credential. File replacement
is atomic; corrupt/undecryptable data is discarded and recovered from the server.
This caches viewed history, not media bytes, drafts or pending send operations.

Successful snapshots prune missing, ended and read-only conversations while keeping
unfinished offline sessions. Unpairing, known loss of transcript permission or
portal suspension clears the cache. During a network outage, previously authorized
saved history remains readable; revocation can be learned only when the app reaches
the server again. The server remains authoritative for permissions, lifecycle,
activity and unread state.
