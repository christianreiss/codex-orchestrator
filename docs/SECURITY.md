# Security Policy

## Supported Versions

Security fixes are applied to the current main branch. Backports are not guaranteed; cherry-pick fixes onto your deployment branch as needed.

## Reporting a Vulnerability

Please email the maintainers or open a private channel with the ops team. Include:
- A clear description of the issue and potential impact.
- Reproduction steps or a proof of concept.
- Any logs or configuration details that help triage (redact secrets).

We will acknowledge receipt within 3 business days and aim to provide an assessment or fix timeline shortly after.

## Operational Expectations

- Admin dashboard must be fronted by mTLS and, if set, `DASHBOARD_ADMIN_KEY`.
- Admins can view and upload raw canonical auth (tokens); restrict access to trusted operators.
- Host IP binding trusts `X-Forwarded-For` / `X-Real-IP`; configure proxies to set and strip these safely.
- Treat `.env`, `storage/`, and database volumes as secrets; they hold API keys, encryption keys, and auth payloads.
