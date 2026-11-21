# Android Companion acceptance, 21 November 2026

Companion 0.10.1 (version code 44) was built on biest.eulie.de and installed on a disposable Android 16 / API 36 emulator. The phone viewport was 320 × 640 at 160 dpi. All accounts, devices, host records, keys and databases used for pairing were created for this test.

## Reproduced and repaired

| ID | Initial behavior | Change and observed outcome |
| --- | --- | --- |
| AND-001 | The software keyboard covered the start action after entering a task on the small phone. | Host start keeps its primary action above the IME while its fields scroll. With the Android keyboard visible, the task and engine selection survived and the fixture accepted the start. |
| AND-002 | With a waiting approval, the fifth chat identity did not fit on the initial 320 dp viewport. At 200% text the test also scrolled to the wrong conversation because it counted data items across section headers. | Short windows use smaller spacing and keep 56 dp minimum hit targets. Narrow layouts stack agent name, host and time. The first five agent rows fit completely at default text size. The lazy list scrolls by stable conversation identity and the last agent opens at 200%. |
| AND-003 | The failed-window-close regression looked for offscreen content before its lazy row existed. | The test scrolls the window into view, verifies the failed close retains it and retries the same action. No change to close semantics was needed. |

[Phone inbox](orchestrator-android/inbox.png) · [Scrolled inbox at 200% text](orchestrator-android/inbox-200.png) · [Start action while typing](orchestrator-android/start-with-keyboard.png) · [Two-pane dark tablet](orchestrator-android/tablet-dark.png)

## Verification

The Android workflow's four Gradle tasks ran with the checked-in 9.4.1 wrapper, Android build tools 36.0.0 and JDK 21 targeting Java 17.

```sh
./gradlew --no-daemon :app:lintDebug :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest
```

The debug and instrumentation APKs were installed with `adb install -r -t`. This exercises Android Keystore, Activity lifecycle, Material Compose layout, system IME and Android NotificationManager. Most UI cases serve fixture API and WebSocket responses. Unit tests use JVM fixtures.

| Final check | Result |
| --- | --- |
| Gradle gates | Both APKs assembled. 202 JVM tests passed, zero skipped. Lint reported 0 errors, 48 warnings and 3 hints. |
| Complete AndroidJUnitRunner at 320 × 640, 100% text | 66 passed, 3 opt-in assumptions skipped, 0 failures in 188.481 s. The localhost pairing test ran in this suite. Initial run on the same viewport had 3 failures. |
| 320 × 640, Android system font scale 2.0 | Dense inbox regression passed. The last conversation remained reachable by scroll and opened. |
| Android 13+ notification permission | Revoked `POST_NOTIFICATIONS` through the package manager before starting the dedicated test. Android reported notifications off, showed no notification, and the unread marker persisted. |
| 900 × 1280, 100% text, Android night mode | Dense inbox regression passed. Visual inspection confirmed the navigation rail, two-pane view and complete row identities. |

The four linked captures came from the installed 0.10.1 debug APK, SHA-256 `32dc817cdbbfd0b252fdc6589793d4c8188a1b5255be89c1e011797e6a1664e5`. The instrumentation APK had SHA-256 `4166e654452c751a9a80b9daaf02223b0d452c5c2a834f1cd8d9f2dde8d0d0a1`. The follow-up runs used the same APKs with the DenseChatHome case at each display setting and `ReplyNotificationTest.notificationOptOutStillRecordsUnreadAndForegroundRestoresSilentBadge` with `-e runtimePermissionDenied true`.

The separate `RemoteLiveTest.loopbackPairingShowsRegisteredHostAndRevokesDevice` used the production Fastify server and an isolated, freshly migrated MySQL schema. An owner registered a synthetic host, enabled its daemon setting and issued a single-use pairing. On the emulator the operator flow pasted the code, confirmed the server and opened Hosts. The test matched the persisted host, replayed the spent code (`pairing_invalid`), revoked the device and checked the same bearer received HTTP 401. Its certificate was trusted only by the test client. The feature guide describes the opt-in fixture. [Companion verification](../android-companion.md#isolated-pairing-and-revocation)

The three optional cases requiring real Firebase registration, Firebase delivery or a live provider-backed host were skipped. Notification rendering and revocation use Android platform APIs on the emulator. The checks give no result for delivery from Google, a physical camera, launcher-specific badges, TalkBack speech output or a native provider conversation. The Android manifest declares no launcher AppWidget.
