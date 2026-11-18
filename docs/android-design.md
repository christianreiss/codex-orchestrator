# Android Companion design standard

Binding for every screen of the native Android app (`mobile/android`). The web
standard is [`DESIGN.md`](../DESIGN.md); this file covers the native app only.
Introduced with Android 0.10.0 (2026-11-18).

## Principles

1. **Inbox first.** The app is a companion: who needs me, what is running, talk to
   it. Everything else (hosts, quotas, approvals, tools) is one tap away, never in
   front of a conversation.
2. **Only what can act is listed.** Offline and ended agents are not in the chat
   list. Their history stays reachable through message search, notifications and
   `orchestrator://chat/{key}` links, which open them read-only.
3. **Words, not infrastructure.** No user-visible text names receivers, relays,
   daemons, slots, the fleet, `cxx`, JSON or raw server states, and no raw IDs or
   UUIDs. A missing value gets a neutral word ("Merge request", "Other state").
4. **State has a colour and a shape.** Status is never colour alone: a dot plus a
   word, an icon plus a label.

## Tokens (`CompanionTheme.kt`)

- **Palette:** fixed light and dark schemes on every Android version; no dynamic
  (wallpaper) colour. Primary `#2D5BE3` (dark `#9DB6FF`); neutral surfaces from
  `surfaceContainerLowest` to `surfaceContainerHighest`. The splash screen,
  launcher background and window background use the same values (`res/values*/colors.xml`).
- **Status roles** (`StatusRole`): the only source of state colour. Literal colours
  in screens are not allowed.

  | Role | Colour | Word (en / de) | Used for |
  |---|---|---|---|
  | `Ready` | success green | Ready / Bereit | takes messages now |
  | `Working` | warning amber | Working / Arbeitet | running a turn |
  | `Waiting` | tertiary violet | Paused / Pausiert | connected, not taking messages; messages wait |
  | `Attention` | primary | Waiting for you / Wartet auf dich | question, notice, approval |
  | `Error` | error | — | failures |
  | `Offline` | outline grey | Offline | stale connection, unavailable host |

- **Type:** `headlineSmall` screen titles, `titleMedium` row titles, `bodyMedium`
  row subtitles, `labelSmall` (uppercase) section headers.
- **Spacing:** `Space.xs/s/m/l/xl` = 4/8/12/16/24 dp.
- **Shapes:** 6/10/14/20/28 dp; bubbles 20 dp with a 6 dp corner at the group start;
  composer and search fields are 24 dp pills without outlines.
- **Icons:** Material Symbols (rounded) through `CompanionSymbol` → `vector()`
  (`CompanionIcons.kt`). Engine logos stay in `res/drawable/ic_engine_*.xml`.

## Shell

- Bottom navigation (rail ≥ 840 dp): **Chats · Hosts · Quotas**, each gated by its
  capability. Approvals and Tools are subpages with a back arrow; the tab they
  belong to stays selected. The Hosts tab carries the count of waiting approvals.
- The chat list's app bar holds conference history, new group (icon) and ⋮.
- ⋮ opens **Settings**: connection (one line, refresh icon), alerts, reply
  notifications, Tools, stop session, Android settings, sign out.
- The **"+" FAB** on Chats starts an agent: pick a startable host, then the start
  sheet (engine, task, plan first, options).

## Row anatomy (`InboxRowFrame`)

Every list row has at most two lines of text:

```
[avatar 48dp + status dot]  Title · host            time
                            status/last message      (unread)
```

- Agent subtitle: the question for `Attention` (in the role colour), the last
  message for `Ready`, otherwise "<status word> · <last message>".
- Rooms: title · participant count; subtitle "<closed/deadline> · <preview>".
- Approvals: shield avatar, host short name, "Asks for temporary access · Review",
  remaining time.
- Sections: **Needs you** (approvals, questions, urgent notices) and **Active**
  (agents and rooms mixed, newest first). The "Active" header only appears when
  "Needs you" is shown.

## Chat

- App bar: avatar with status dot, title, one status line "<status word> · host".
- Own bubbles are solid primary; agent bubbles a filled neutral surface without an
  outline; important notices use the error container.
- When the agent is connected but not taking messages and the server supports
  the queue (`portal_queue_protocol`), the composer stays enabled and a clock
  hint says the message waits. Waiting messages show "Waiting for the agent" and
  offer **Don't send** in the long-press menu.

## Text replacements (0.10.0)

| Before | After (en) | After (de) |
|---|---|---|
| Server · Connected / Connecting… / Disconnected · Reconnecting… | Connected / Connecting… / Offline · reconnecting… | Verbunden / Verbindung wird aufgebaut… / Offline · verbinde neu… |
| Online · Can receive messages / Receiver unavailable | Ready / Paused | Bereit / Pausiert |
| Read by AI / AI is working… | Read / Working on it… | Gelesen / Wird bearbeitet… |
| Agent is no longer reachable | This agent can't take messages right now | Dieser Agent nimmt gerade keine Nachrichten an |
| Waiting for daemon installation / Daemon service user does not match / Daemon needs attention | Still being set up / Runs under the wrong user account / Needs attention on the host | Wird noch eingerichtet / Läuft unter dem falschen Benutzerkonto / Braucht Aufmerksamkeit auf dem Host |
| All slots are occupied / N free slots · engines | Busy – no free capacity / N free · engines | Ausgelastet – keine freie Kapazität / N frei · Engines |
| Requesting IP: x | From x | Von x |
| Fleet window | Access for all hosts | Zugriff für alle Hosts |
| Update cxx to answer here | This agent needs an update to answer here | Dieser Agent braucht ein Update, um hier zu antworten |
| Pairing JSON | Pairing code | Kopplungscode |
| Outcome unknown — inspect the session on the host | Unclear how this session ended – check it on the host | Unklar, wie die Sitzung endete – auf dem Host prüfen |
| WIP limit N | Limit N | Limit N |
| raw quota account `state` | hidden when enabled, else Switched off / Limited right now / Needs attention | Abgeschaltet / Gerade begrenzt / Braucht Aufmerksamkeit |

## Review

UI changes are checked against this file with before/after emulator screenshots
from `CompanionUiTest` (`screenshot(...)`, pulled from `/data/local/tmp`) in light
and dark mode, and run through the fleet slop review before release.
