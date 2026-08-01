# wrapper v2 storage

This directory is the runtime home of the wrapper bakery v2:

- `bin/cxx/<os>-<arch>/v<version>/cxx` — published per-platform binaries.
- `cache/<host_id>/<engine>/<config_version>/{config.json,config.json.sig,meta.json}` — pre-baked configs.
- `keys/installation-signing.ed25519` — temporary mode-0600 installation key; `bin/setup.sh` removes it only after encrypted database read-back succeeds.
- `keys/installation-signing.ed25519.pub` — installation public key embedded into the Go binaries at build time.

The active private key is stored encrypted in `wrapper_signing_keys`; an
interrupted prepare-only run deliberately retains the temporary plaintext key
so the same installation can continue without rotating trust.
