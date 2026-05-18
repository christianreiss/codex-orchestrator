# Codex Orchestrator wrapper bakery v2 — build, test, lint, release targets.
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo 0.6.0-dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# Output goes under storage/wrapper/v2/bin so the orchestrator serves it directly.
OUTROOT ?= ../storage/wrapper/v2/bin

GO ?= go
LDFLAGS := -s -w \
	-X 'main.Version=$(VERSION)' \
	-X 'main.Commit=$(COMMIT)' \
	-X 'main.BuildDate=$(DATE)'

# Platform matrix kept in sync with .github/workflows/wrappers.yml.
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64

.PHONY: all build cdx clx test vet lint clean release pubkey

all: cdx clx

cdx:
	cd cdx && $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o ../bin/cdx ./cmd/cdx

clx:
	cd clx && $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o ../bin/clx ./cmd/clx

test:
	cd cdx && $(GO) test ./...
	cd clx && $(GO) test ./...

vet:
	cd cdx && $(GO) vet ./...
	cd clx && $(GO) vet ./...

clean:
	rm -rf bin

# Cross-compile the entire platform matrix into $(OUTROOT)/<engine>/<os>-<arch>/v<version>/<binary>.
# Used locally; CI does the same via GitHub Actions matrix.
release:
	@set -e; \
	v=$$(echo "$(VERSION)" | sed 's/^v//'); \
	for engine in cdx clx; do \
		route_engine="codex"; \
		if [ "$$engine" = "clx" ]; then route_engine="claude"; fi; \
		for plat in $(PLATFORMS); do \
			os=$${plat%/*}; arch=$${plat##*/}; \
			platform="$$os-$$arch"; \
			platform_dir="$(OUTROOT)/$$route_engine/$$platform"; \
			outdir="$$platform_dir/v$$v"; \
			mkdir -p "$$outdir"; \
			outbin="$$(cd "$$outdir" && pwd)/$$engine"; \
			echo ">> $$engine $$os/$$arch -> $$outbin"; \
			(cd $$engine && GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o "$$outbin" ./cmd/$$engine); \
			sha=$$(sha256sum "$$outbin" | awk '{print $$1}'); \
			size=$$(wc -c < "$$outbin" | tr -d ' '); \
			printf '%s  %s\n' "$$sha" "$$engine" > "$$outdir/$$engine.sha256"; \
			printf '{\n  "engine": "%s",\n  "os": "%s",\n  "arch": "%s",\n  "current": "%s",\n  "builds": [\n    {\n      "version": "%s",\n      "sha256": "%s",\n      "size_bytes": %s,\n      "signature": null,\n      "published_at": "%s"\n    }\n  ]\n}\n' \
				"$$route_engine" "$$os" "$$arch" "$$v" "$$v" "$$sha" "$$size" "$(DATE)" > "$$platform_dir/manifest.json"; \
		done; \
	done

# Materialize the embedded signing pubkey from storage/wrapper/v2/keys/signing.ed25519.pub.
# Re-run after the operator rotates keys; commits both files.
pubkey:
	@if [ ! -f ../storage/wrapper/v2/keys/signing.ed25519.pub ]; then \
		echo "missing storage/wrapper/v2/keys/signing.ed25519.pub — run scripts/wrapper-v2-init-keys.sh first" >&2; exit 1; \
	fi
	@cp ../storage/wrapper/v2/keys/signing.ed25519.pub cdx/internal/signing/pubkey.pem
	@cp ../storage/wrapper/v2/keys/signing.ed25519.pub clx/internal/signing/pubkey.pem
