---
title: Grok Build (cgx)
section: Fleet operations
category: Fleet operations
summary: Grok subscription accounts, centralized renewal, isolated launches, native reception, and gateway limits.
verified: 2026-10-01
sources: docs/interface-cgx.md, api/src/services/grok-auth-owner.ts, runner/grok.py, wrappers/cxx/internal/grok
---

Grok Build is the fleet's third engine. Select **Grok** alongside Codex and Claude
when registering a host; any nonempty combination is supported. `cgx` launches
Grok through the same signed `cxx` wrapper binary as `cdx` and `clx`.

## Subscription login

In Accounts, select Grok and upload the complete `~/.grok/auth.json` from a modern
`grok login --device-auth` subscription login. Keep the complete scope map; don't
add a timestamp at its root. Legacy web login and metered xAI API keys are not
supported. The server validates account identity, encrypts canonical credentials,
and owns OAuth renewal. Hosts and runners receive only access tokens.

An interrupted refresh can remain pending or uncertain. Pending verification
rechecks the captured replacement. An uncertain spend requires a distinct modern
login rather than retrying an already-spent token. A login-required account also
needs a fresh subscription login. Existing sessions stay pinned to their account.

## Models and runtime

Quick Settings and Engines expose Grok's model and effort independently. The
baseline is Grok4.6/high (low, medium, high, xhigh); Grok4.5 supports low through
high. These are native supported IDs; subscription availability is provider-owned.
Codex quota lanes/profiles and Claude native artifact editors remain engine-specific.
Grok quota is explicitly unknown when no supported provider snapshot exists.

Managed launches use a private Grok home and leader to prevent native auth reloads
from selecting an unmanaged account. The original session-history root is shared,
so resume by UUID/title and continue remain available. The native receiver binds
that session and admits messages through its ACP queue. Queue admission is not an
agent reply. An explicit unmanaged no-leader/custom-socket launch reports receiver
unavailability honestly.

## HTTP gateway

API Access provides Grok's independent switch and gateway keys. The base path is
`/grok/v1`; its `sk-cgx-` keys belong to the orchestrator and are not xAI API keys.
Chat completions, responses, completions, and model discovery are supported.
Text, model, and system instructions are supported; streaming, tools, sampling,
stop sequences, output caps, images, and embeddings return explicit errors.
Native usage and stop reason are returned when available; missing usage stays unknown.
