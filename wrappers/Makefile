# Codex Orchestrator wrapper bakery v2 — build, test, lint, release targets.
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

VERSION ?= 0.7.5
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# Release builds stage locally by default. Publishing into the live served
# store is a separate, explicit target with immutable-version validation.
OUTROOT ?= bin/release
PUBLISH_ROOT ?= ../storage/wrapper/v2/bin

GO ?= go
PYTHON ?= python3
LDFLAGS := -s -w \
	-X 'main.Version=$(VERSION)' \
	-X 'main.Commit=$(COMMIT)' \
	-X 'main.BuildDate=$(DATE)'

# Platform matrix kept in sync with .github/workflows/wrappers.yml.
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64

.PHONY: all build cxx cdx clx test vet lint clean release publish-release pubkey

all: cxx

build: cxx

cxx:
	cd cxx && $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o ../bin/cxx ./cmd/cxx

# Compatibility build targets intentionally converge on the same artifact.
cdx clx: cxx

test:
	cd cxx && $(GO) test ./...
	PYTHONDONTWRITEBYTECODE=1 $(PYTHON) scripts/test-merge-manifest.py
	PYTHONDONTWRITEBYTECODE=1 $(PYTHON) scripts/test-publish-release.py

vet:
	cd cxx && $(GO) vet ./...

clean:
	rm -rf bin

# Cross-compile one artifact per platform into the canonical cxx store.
release:
	@set -e; \
	v=$$(echo "$(VERSION)" | sed 's/^v//'); \
	for plat in $(PLATFORMS); do \
		os=$${plat%/*}; arch=$${plat##*/}; \
		platform="$$os-$$arch"; \
		platform_dir="$(OUTROOT)/cxx/$$platform"; \
		outdir="$$platform_dir/v$$v"; \
		mkdir -p "$$outdir"; \
		outbin="$$(cd "$$outdir" && pwd)/cxx"; \
		echo ">> cxx $$os/$$arch -> $$outbin"; \
		(cd cxx && GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o "$$outbin" ./cmd/cxx); \
		sha=$$(sha256sum "$$outbin" | awk '{print $$1}'); \
		size=$$(wc -c < "$$outbin" | tr -d ' '); \
		printf '%s  cxx\n' "$$sha" > "$$outdir/cxx.sha256"; \
		PYTHONDONTWRITEBYTECODE=1 $(PYTHON) scripts/merge-manifest.py \
			"$$platform_dir/manifest.json" cxx "$$os" "$$arch" "$$v" "$$sha" "$$size" "$(DATE)"; \
	done

# Publish a previously staged VERSION into the served wrapper store. Version
# directories are immutable; manifests are merged atomically so rollback
# entries survive later publications.
publish-release:
	PYTHONDONTWRITEBYTECODE=1 $(PYTHON) scripts/publish-release.py "$(OUTROOT)" "$(PUBLISH_ROOT)" "$$(echo "$(VERSION)" | sed 's/^v//')"

# Materialize the embedded signing pubkey from storage/wrapper/v2/keys/signing.ed25519.pub.
# Re-run after the operator rotates keys; commits both files.
pubkey:
	@if [ ! -f ../storage/wrapper/v2/keys/signing.ed25519.pub ]; then \
		echo "missing storage/wrapper/v2/keys/signing.ed25519.pub — run scripts/wrapper-v2-init-keys.sh first" >&2; exit 1; \
	fi
	@cp ../storage/wrapper/v2/keys/signing.ed25519.pub cxx/internal/signing/pubkey.pem
