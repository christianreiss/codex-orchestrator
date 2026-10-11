# Operator agent chat

Agent chat is the existing Active Clients / Android Chats conversation with managed Codex, Claude and Grok sessions. It uses the existing session/daemon binding, delivery receipts and retention. It is separate from the product assistant.

Questions choose `buttons`, `text` or `both`. A choice has a display `label` and stable `value`; button answers send the value. The first queued answer owns the question, and exact retries retain their original operation. Normal questions appear under Your answer. Only explicit `important`, `critical` or `blocker` with a stable notice UUID appears under Needs you. Reading, replying, becoming offline or ending does not clear classified notices; operator/agent resolution targets one UUID. Unresolved notices retain the relevant existing session context until resolution, then its ordinary retention resumes. Identical notice/severity pushes deduplicate; escalation permits one new notification.

## Files and media

Both sides upload into the authenticated conversation, with stable UUIDs, bounded chunks and SHA-256 sealing. Author/conversation checks run again when sending. Defaults: ten attachments, 100 MiB/file, 250 MiB total; configurable API limits use `AGENT_CHAT_MAX_FILE_BYTES` and `AGENT_CHAT_MAX_TOTAL_BYTES`. Web uses the effective limits; Android/wrapper also enforce their built-in 100 MiB ceiling. Originals and names remain unchanged. Upload progress, cancel and retry preserve the same upload ID; drafts are per conversation. Uploads not sent expire after 24 hours. Linked files follow retained conversation context. New reply references name an existing event in that logical conversation. Copy/Markdown rendering do not execute HTML or attachment contents.

Installer and deploy prepare only `store/agent-chat` as UID/GID 10001 with mode 0700; the parent store keeps its existing ownership. The `media-worker` Compose service shares only DATA_ROOT's store, runs as API UID/GID 10001 and has no network, a read-only root, temporary /tmp, two CPUs and a 4 GiB memory limit. Whisper small is baked at a fixed model revision, with CPU int8 inference. Audio/video up to 15 minutes yield timestamped transcript JSON; video also yields at most twenty timestamped JPEG frames. Each job is bounded to twenty minutes with three persisted retries across restarts. Decoder failures publish failed state and preserve downloadable originals. FFmpeg restricts protocols/container formats and first creates a local WAV for ASR. Media support depends on the actual codec/container; unsupported recordings retain their originals.

Metadata is encrypted in MySQL; file bytes are private on the store volume. Downloads enforce existing transcript access, include nosniff, sandboxed content disposition and safe inline MIME handling, and support byte ranges for playback. Store-volume backups cover originals/derived media; MySQL backups alone do not.

## Agent usage

Use `agent_portal_ask` with stable `client_event_id`, `prompt_id`, `answer_mode` and optional `choices`. Add `severity`, `notice_id` and a short reason in `summary` only when operator attention is important/critical/blocking. `agent_portal_notify` publishes a classified notice; `agent_portal_resolve` resolves one. Retain caller IDs on retry.

Upload a local file with `agent_attachment_upload` (`upload_id`, `path`, `mime_type`), then pass returned IDs in `agent_receiver_reply.attachments` or a question. Incoming instructions include `metadata.attachments` and optional `reply_to`. `agent_attachment_get` takes an attachment UUID and optional `original`, `transcript.json` or `frame-NN.jpg`, returning metadata, preparation state and a local path for the engine's own file/image tools. Preparation is asynchronous: recheck queued results or inspect the original. No automatic execution or authority is inferred from files.

## Rollout and rollback

Build/check the API and WebUI, build/vet/test cxx, and build/lint/test Android. `scripts/deploy.sh --backup --no-cleanup` publishes cxx 0.9.57, applies idempotent migration 0057 and rebuilds/restarts the Compose stack including the worker. Keep the previous API/worker image tags and database/store backup. For rollback stop the worker and deploy the previous source/image; the added nullable/default columns and tables can remain. Do not drop them while rich messages exist. Android 0.4.13 is a signed APK; physical Pixel installation is deferred.
