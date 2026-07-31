#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_VERSION="1.0.0"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_PREFIX="codex-orchestrator"
DEFAULT_OUTPUT_DIR="/home/chris/Downloads"
DEFAULT_DATE_FORMAT="%F"
DATE_FORMAT="${DEFAULT_DATE_FORMAT}"
OUTPUT_PATH=""
COMPONENT="all"
INCLUDE_TESTS=1
RUN_CLEANUP=1

ALL_COMPONENTS=(api frontend wrappers runner docs)

declare -a WRITTEN_OUTPUTS=()
declare -A WRITTEN_OUTPUT_SET=()
CLEANUP_TOTAL_REMOVED=0

usage() {
  cat <<'EOF'
Usage: scripts/export_ai_bundle.sh [options]

Create AI-friendly text bundles from the orchestrator API, admin frontend,
Go wrappers, auth runner, and the doc set.

Options:
  -o, --output PATH         Output path. For --component all: directory. For single component: file path.
      --date-format FORMAT  strftime format for default filename date (default: %F)
      --component NAME      one of: all, api, frontend, wrappers, runner, docs (default: all)
      --no-tests            Exclude test files from output
      --no-cleanup          Keep older export files instead of removing them
  -h, --help                Show this help

Default output:
  /home/chris/Downloads/codex-orchestrator-{api|frontend|wrappers|runner|docs}-YYYY-MM-DD-HH_MM.txt

Cleanup (default on):
  Removes old export files matching
  codex-orchestrator-<component>-YYYY-MM-DD-HH_MM.txt
  in the used output directory/directories after successful export.
  Only the components exported in this run are pruned.
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

canonicalize_component() {
  local value="$1"
  case "${value}" in
    all|api|frontend|wrappers|runner|docs) printf '%s' "${value}" ;;
    *) die "Invalid --component '${value}'. Use one of: all, api, frontend, wrappers, runner, docs." ;;
  esac
}

while (($# > 0)); do
  case "$1" in
    -o|--output)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      OUTPUT_PATH="$2"
      shift 2
      ;;
    --date-format)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      DATE_FORMAT="$2"
      shift 2
      ;;
    --component)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      COMPONENT="$(canonicalize_component "$2")"
      shift 2
      ;;
    --no-tests)
      INCLUDE_TESTS=0
      shift
      ;;
    --no-cleanup)
      RUN_CLEANUP=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
bundle_date="$(date +"${DATE_FORMAT}")"
bundle_time="$(date +'%H_%M')"

command -v git >/dev/null 2>&1 || die "git is required but not found in PATH."
git -C "${ROOT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "Not a git work tree: ${ROOT_DIR}"

# ---------------------------------------------------------------------------
# Component definitions
#
# PREFIXES  : path prefixes whose code/config is in scope (space separated)
# DOCS      : canonical docs pulled in verbatim even though markdown is
#             otherwise excluded
# DOC_TREES : prefixes under which *every* tracked markdown file is included
# ---------------------------------------------------------------------------

# Included in every bundle: the docs an agent needs to orient itself plus the
# deployment surface that ties the components together.
declare -a ROOT_DOCS=(
  "AGENTS.md"
  "README.md"
  "TODO.md"
)
declare -a ROOT_INFRA_FILES=(
  "Dockerfile"
  "docker-compose.yml"
  ".dockerignore"
  ".env.example"
  ".gitignore"
  ".gitattributes"
)
declare -a ROOT_INFRA_PREFIXES=(
  "caddy/"
  "scripts/"
  "bin/"
  ".github/"
)

declare -A COMPONENT_PREFIXES=(
  [api]="api/"
  [frontend]="frontend/ public/admin/manual/"
  [wrappers]="wrappers/ storage/wrapper/"
  [runner]="runner/"
  [docs]="docs/"
)

declare -A COMPONENT_DOCS=(
  [api]="api/README.md api/src/db/README.md api/test/contract/README.md docs/API.md docs/OVERVIEW.md docs/MCP.md docs/SECURITY.md docs/LOGIN.md docs/CONFIG_BUILDER.md docs/auth-runner.md docs/interface-api.md docs/interface-db.md docs/skills/README.md docs/contracts/README.md"
  [frontend]="docs/ADMIN.md docs/admin-ui-design-spec.md docs/admin-ui-redesign-brief.md docs/redesign-discovery.md"
  [wrappers]="wrappers/README.md storage/wrapper/v2/README.md docs/INSTALL.md docs/USAGE.md docs/interface-cdx.md docs/interface-clx.md docs/wrapper-v2-architecture.md"
  [runner]="runner/README.md docs/auth-runner.md"
  [docs]=""
)

declare -A COMPONENT_DOC_TREES=(
  [api]=""
  [frontend]="public/admin/manual/"
  [wrappers]=""
  [runner]=""
  [docs]="docs/"
)

# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

is_secret_file() {
  local path="$1"
  case "${path}" in
    */pubkey.pem) return 1 ;;
    .env|*/.env) return 0 ;;
    .env.example|*/.env.example) return 1 ;;
    .env.*|*/.env.*) return 0 ;;
    *.pem|*.key|*.p12|*.pfx|*.jks|*.keystore|*.crt) return 0 ;;
    */credentials.json|*/id_rsa|*/id_ed25519) return 0 ;;
  esac
  return 1
}

is_path_excluded() {
  local path="$1"

  # Committed build output and generated indexes.
  case "${path}" in
    public/admin/_app/*) return 0 ;;
    public/go/assets/*) return 0 ;;
    public/admin/manual/search-index.json) return 0 ;;
  esac

  case "${path}" in
    */.git/*|.git/*) return 0 ;;
    node_modules/*|*/node_modules/*) return 0 ;;
    dist/*|*/dist/*|build/*|*/build/*|.svelte-kit/*|*/.svelte-kit/*) return 0 ;;
    __pycache__/*|*/__pycache__/*|.pytest_cache/*|*/.pytest_cache/*) return 0 ;;
    improver/*|vendor/*|*/vendor/*) return 0 ;;
    */testdata/*) return 0 ;;
  esac

  # Lockfiles: large, generated, no signal for a reading model.
  case "${path##*/}" in
    package-lock.json|pnpm-lock.yaml|yarn.lock|go.sum) return 0 ;;
  esac

  case "${path}" in
    *.min.js|*.min.css|*.map) return 0 ;;
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.svg|*.pdf) return 0 ;;
    *.zip|*.gz|*.tar|*.bin|*.so|*.dylib|*.exe|*.wasm) return 0 ;;
    *.woff|*.woff2|*.ttf|*.otf|*.eot) return 0 ;;
  esac

  return 1
}

is_test_path() {
  local path="$1"
  case "${path}" in
    api/test/*) return 0 ;;
    *.test.ts|*.test.js|*.spec.ts|*.spec.js) return 0 ;;
    *_test.go) return 0 ;;
    runner/test_*.py|*/test_*.py) return 0 ;;
    wrappers/scripts/test-*.py) return 0 ;;
  esac
  return 1
}

should_include_by_extension() {
  local path="$1"
  local base="${path##*/}"

  case "${base}" in
    Dockerfile|Makefile|Caddyfile|go.mod|go.work|requirements.txt|entrypoint.sh)
      return 0
      ;;
    .gitignore|.dockerignore|.gitattributes|.npmrc|.prettierrc|.env.example)
      return 0
      ;;
  esac

  case "${path}" in
    *.ts|*.tsx|*.js|*.mjs|*.cjs|*.jsx|*.svelte|*.go|*.py|*.sql|*.json|*.css|*.html|*.yml|*.yaml|*.sh|*.toml|*.conf|*.caddy)
      return 0
      ;;
  esac

  return 1
}

language_hint() {
  local path="$1"
  case "${path##*/}" in
    Dockerfile) echo "dockerfile"; return ;;
    Makefile) echo "makefile"; return ;;
    Caddyfile) echo "caddyfile"; return ;;
    go.mod|go.work) echo "gomod"; return ;;
    .gitignore|.dockerignore) echo "gitignore"; return ;;
    .npmrc|.prettierrc) echo "ini"; return ;;
  esac
  case "${path}" in
    *.ts|*.tsx) echo "typescript" ;;
    *.js|*.mjs|*.cjs|*.jsx) echo "javascript" ;;
    *.svelte) echo "svelte" ;;
    *.go) echo "go" ;;
    *.py) echo "python" ;;
    *.sql) echo "sql" ;;
    *.json) echo "json" ;;
    *.css) echo "css" ;;
    *.html) echo "html" ;;
    *.yml|*.yaml) echo "yaml" ;;
    *.sh) echo "bash" ;;
    *.toml) echo "toml" ;;
    *.conf|*.caddy) echo "caddyfile" ;;
    *.md|*.MD) echo "markdown" ;;
    *.txt) echo "text" ;;
    *) echo "text" ;;
  esac
}

has_prefix() {
  local path="$1"
  shift
  local prefix
  for prefix in "$@"; do
    [[ -n "${prefix}" ]] || continue
    [[ "${path}" == "${prefix}"* ]] && return 0
  done
  return 1
}

default_output_path_for_component() {
  printf '%s/%s-%s-%s-%s.txt' \
    "${DEFAULT_OUTPUT_DIR}" \
    "${BUNDLE_PREFIX}" \
    "$1" \
    "${bundle_date}" \
    "${bundle_time}"
}

# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

declare -a TRACKED_FILES=()
mapfile -t TRACKED_FILES < <(git -C "${ROOT_DIR}" ls-files | LC_ALL=C sort -u)
((${#TRACKED_FILES[@]} > 0)) || die "git ls-files returned nothing in ${ROOT_DIR}."

export_bundle_for_component() {
  local component="$1"
  local output_path="$2"

  [[ -n "${COMPONENT_PREFIXES[${component}]+x}" ]] \
    || die "Internal error: unsupported component '${component}'"

  local -a warnings=()
  local -a secret_excluded=()

  # The definition tables are space separated; the global IFS is not.
  local -a code_prefixes=()
  IFS=' ' read -r -a code_prefixes <<<"${COMPONENT_PREFIXES[${component}]}"
  local -a doc_trees=()
  IFS=' ' read -r -a doc_trees <<<"${COMPONENT_DOC_TREES[${component}]}"

  local -A canonical_doc_set=()
  local -a canonical_docs=("${ROOT_DOCS[@]}")
  local -a component_docs=()
  IFS=' ' read -r -a component_docs <<<"${COMPONENT_DOCS[${component}]}"
  ((${#component_docs[@]} > 0)) && canonical_docs+=("${component_docs[@]}")

  local doc
  for doc in "${canonical_docs[@]}"; do
    canonical_doc_set["${doc}"]=1
    [[ -f "${ROOT_DIR}/${doc}" ]] || warnings+=("Canonical doc missing: ${doc}")
  done

  local -A root_infra_set=()
  local infra
  for infra in "${ROOT_INFRA_FILES[@]}"; do
    root_infra_set["${infra}"]=1
    [[ -f "${ROOT_DIR}/${infra}" ]] || warnings+=("Root infra file missing: ${infra}")
  done

  local -a selected_files=()
  local path
  for path in "${TRACKED_FILES[@]}"; do
    if [[ -n "${canonical_doc_set[${path}]:-}" ]]; then
      selected_files+=("${path}")
      continue
    fi

    # Scope: component code, component doc tree, or shared root infra.
    if ! has_prefix "${path}" "${code_prefixes[@]}" \
      && ! has_prefix "${path}" "${doc_trees[@]}" \
      && ! has_prefix "${path}" "${ROOT_INFRA_PREFIXES[@]}" \
      && [[ -z "${root_infra_set[${path}]:-}" ]]; then
      continue
    fi

    if is_secret_file "${path}"; then
      secret_excluded+=("${path}")
      continue
    fi

    if is_path_excluded "${path}"; then
      continue
    fi

    case "${path}" in
      *.md|*.MD|*.rst)
        # Non-canonical prose only ships for components that declare a doc tree.
        if has_prefix "${path}" "${doc_trees[@]}"; then
          selected_files+=("${path}")
        fi
        continue
        ;;
    esac

    if ((INCLUDE_TESTS == 0)) && is_test_path "${path}"; then
      continue
    fi

    if should_include_by_extension "${path}"; then
      selected_files+=("${path}")
    fi
  done

  ((${#selected_files[@]} > 0)) \
    || die "Selection is empty after filtering for component '${component}'."

  local output_dir
  output_dir="$(dirname "${output_path}")"
  mkdir -p "${output_dir}"

  local tmp_output
  tmp_output="$(mktemp "${output_dir}/.ai_bundle.${component}.XXXXXX.tmp")"

  local total_bytes=0
  local full_path size
  for path in "${selected_files[@]}"; do
    full_path="${ROOT_DIR}/${path}"
    if [[ ! -f "${full_path}" ]]; then
      warnings+=("Selected file missing at write time: ${path}")
      continue
    fi
    size="$(wc -c <"${full_path}")"
    total_bytes=$((total_bytes + size))
  done

  {
    echo "===== AI BUNDLE EXPORT ====="
    echo "SCRIPT_VERSION: ${SCRIPT_VERSION}"
    echo "GENERATED_AT_UTC: ${timestamp}"
    echo "WORKSPACE_ROOT: ${ROOT_DIR}"
    echo "GIT_COMMIT: $(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "COMPONENT: ${component}"
    if ((INCLUDE_TESTS)); then
      echo "INCLUDE_TESTS: yes"
    else
      echo "INCLUDE_TESTS: no"
    fi
    echo "OUTPUT_PATH: ${output_path}"
    echo "FILE_COUNT: ${#selected_files[@]}"
    echo "TOTAL_BYTES: ${total_bytes}"
    echo "EXCLUDED_SECRET_COUNT: ${#secret_excluded[@]}"
    echo
    echo "===== INCLUDE POLICY ====="
    echo "Tracked files only (git ls-files), scoped to this component's paths."
    echo "Scope: ${COMPONENT_PREFIXES[${component}]}"
    echo "Canonical docs included explicitly; shared root docs + deploy surface in every bundle."
    echo "Code/config selected by extension + explicit filename allowlist."
    echo
    echo "===== EXCLUDE POLICY ====="
    echo "Secrets: .env (except .env.example), key material, credentials."
    echo "Build output: public/admin/_app, public/go/assets, dist/build/.svelte-kit, generated search-index.json."
    echo "Lockfiles (package-lock.json, go.sum), source maps, minified assets, binary/media files."
    echo "Non-canonical markdown outside a declared doc tree (CHANGELOG.md included)."
    echo
    if ((${#warnings[@]} > 0)); then
      echo "===== WARNINGS ====="
      local warning
      for warning in "${warnings[@]}"; do
        echo "- ${warning}"
      done
      echo
    fi

    echo "===== MANIFEST ====="
    local index=1
    for path in "${selected_files[@]}"; do
      printf '%04d %s\n' "${index}" "${path}"
      index=$((index + 1))
    done
    echo

    if ((${#secret_excluded[@]} > 0)); then
      echo "===== EXCLUDED SECRET FILES (PATHS ONLY) ====="
      for path in "${secret_excluded[@]}"; do
        echo "${path}"
      done
      echo
    fi

    echo "===== FILE CONTENT ====="
    local lang
    for path in "${selected_files[@]}"; do
      full_path="${ROOT_DIR}/${path}"
      [[ -f "${full_path}" ]] || continue
      size="$(wc -c <"${full_path}")"
      lang="$(language_hint "${path}")"
      echo "===== BEGIN FILE: ${path} ====="
      echo "LANG: ${lang}"
      echo "SIZE_BYTES: ${size}"
      cat "${full_path}"
      echo
      echo "===== END FILE: ${path} ====="
      echo
    done

    echo "===== END AI BUNDLE ====="
  } >"${tmp_output}"

  mv "${tmp_output}" "${output_path}"
  WRITTEN_OUTPUTS+=("${output_path}")
  WRITTEN_OUTPUT_SET["${output_path}"]=1

  echo "Wrote AI bundle (${component}):"
  echo "  ${output_path}"
  echo "Files: ${#selected_files[@]}  Bytes: ${total_bytes}  Excluded secrets: ${#secret_excluded[@]}"
}

# Only prunes the components this run actually exported, so `--component api`
# never deletes yesterday's frontend bundle.
cleanup_old_exports() {
  local directory="$1"
  local component_alternation="$2"
  [[ -d "${directory}" ]] || return 0

  local pattern="^${BUNDLE_PREFIX}-(${component_alternation})-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}_[0-9]{2}\.txt$"

  local -a removed=()
  local base_name full_path
  while IFS= read -r base_name; do
    [[ "${base_name}" =~ ${pattern} ]] || continue
    full_path="${directory}/${base_name}"
    [[ -n "${WRITTEN_OUTPUT_SET[${full_path}]:-}" ]] && continue
    rm -f -- "${full_path}"
    removed+=("${full_path}")
  done < <(find "${directory}" -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)

  ((${#removed[@]} > 0)) || return 0

  CLEANUP_TOTAL_REMOVED=$((CLEANUP_TOTAL_REMOVED + ${#removed[@]}))
  echo "Removed old export files in ${directory}:"
  local removed_path
  for removed_path in "${removed[@]}"; do
    echo "  ${removed_path}"
  done
}

declare -A cleanup_dirs=()
declare -a components_to_export=()

if [[ "${COMPONENT}" == "all" ]]; then
  components_to_export=("${ALL_COMPONENTS[@]}")
else
  components_to_export=("${COMPONENT}")
fi

if [[ "${COMPONENT}" == "all" ]]; then
  output_dir="${OUTPUT_PATH:-${DEFAULT_OUTPUT_DIR}}"
  if [[ -e "${output_dir}" && ! -d "${output_dir}" ]]; then
    die "--output must be a directory when --component all: ${output_dir}"
  fi
  mkdir -p "${output_dir}"
  cleanup_dirs["${output_dir}"]=1

  for component_name in "${components_to_export[@]}"; do
    component_output="${output_dir}/${BUNDLE_PREFIX}-${component_name}-${bundle_date}-${bundle_time}.txt"
    export_bundle_for_component "${component_name}" "${component_output}"
  done
else
  if [[ -n "${OUTPUT_PATH}" ]]; then
    if [[ -d "${OUTPUT_PATH}" ]]; then
      die "--output must be a file path when exporting a single component: ${OUTPUT_PATH}"
    fi
    component_output="${OUTPUT_PATH}"
  else
    component_output="$(default_output_path_for_component "${COMPONENT}")"
  fi

  export_bundle_for_component "${COMPONENT}" "${component_output}"
  cleanup_dirs["$(dirname "${component_output}")"]=1
fi

if ((RUN_CLEANUP)); then
  cleanup_components="$(
    IFS='|'
    printf '%s' "${components_to_export[*]}"
  )"
  for cleanup_dir in "${!cleanup_dirs[@]}"; do
    cleanup_old_exports "${cleanup_dir}" "${cleanup_components}"
  done
fi

echo "Export complete. Bundles written: ${#WRITTEN_OUTPUTS[@]}"
echo "Old export files removed: ${CLEANUP_TOTAL_REMOVED}"
