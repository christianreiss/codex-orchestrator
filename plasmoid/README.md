# Codex Orchestrator — Plasma 6 widget

Panel widget for the orchestrator: approve/deny insecure host requests (with a badge and a
desktop notification), extend or close host windows, view engine quotas, read and write room chats.

It talks to the paired-device API (`/companion/v1/*`, Bearer credential, 1 year). The credential
is stored with `secret-tool` (libsecret, backed by KWallet), never in the Plasma config.

Install / update: `kpackagetool6 -t Plasma/Applet -i org.codex.orchestrator` (or `-u` to upgrade),
then add "Codex Orchestrator" to a panel. Pair via dashboard → Account → Android devices.
Requires an admin with `hosts.activate_insecure`. Revoke the device in the dashboard to cut access.
