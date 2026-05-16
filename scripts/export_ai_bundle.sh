#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_VERSION="1.1.0"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_OUTPUT_DIR="/home/chris/Downloads"
DEFAULT_DATE_FORMAT="%F"
DATE_FORMAT="${DEFAULT_DATE_FORMAT}"
OUTPUT_PATH=""
COMPONENT="all"
INCLUDE_TESTS=1

declare -a WRITTEN_OUTPUTS=()
declare -A WRITTEN_OUTPUT_SET=()
CLEANUP_TOTAL_REMOVED=0

usage() {
  cat <<'EOF'
Usage: scripts/export_ai_bundle.sh [options]

Create AI-friendly text bundles for Codex Orchestrator.

Options:
  -o, --output PATH         Output path. For --component all: directory. For single component: file path.
      --date-format FORMAT  strftime format for default filename date (default: %F)
      --component NAME      one of: all, app, wrapper, runner (default: all)
      --no-tests            Exclude test files from output
  -h, --help                Show this help

Default output:
  /home/chris/Downloads/codex-orchestrator-{app|wrapper|runner}-YYYY-MM-DD-HH_MM.txt

Cleanup (default on):
  Removes old export files matching:
  codex-orchestrator-{app|wrapper|runner}-YYYY-MM-DD-HH_MM.txt
  in the used output directory/directories after successful export.
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

canonicalize_component() {
  local value="$1"
  case "${value}" in
    all|app|wrapper|runner) printf '%s' "${value}" ;;
    *) die "Invalid --component '${value}'. Use one of: all, app, wrapper, runner." ;;
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

if ! command -v git >/dev/null 2>&1; then
  die "git is required but not found in PATH."
fi

declare -a COMMON_DOCS=(
  "AGENTS.md"
  "README.md"
  "CHANGELOG.md"
  "DESIGN.md"
  "docs/OVERVIEW.md"
  "docs/API.md"
  "docs/MCP.md"
  "docs/interface-api.md"
  "docs/interface-db.md"
  "docs/interface-cdx.md"
)
declare -a APP_DOCS=(
  "docs/ADMIN.md"
  "docs/CONFIG_BUILDER.md"
  "docs/LOGIN.md"
  "docs/SECURITY.md"
  "docs/contracts/README.md"
  "docs/contracts/auth-retrieve.schema.json"
  "docs/contracts/auth-store.schema.json"
  "docs/contracts/sync-bootstrap.schema.json"
  "docs/contracts/sync-status.schema.json"
  "docs/contracts/usage-ingest.schema.json"
  "docs/contracts/versions.schema.json"
)
declare -a WRAPPER_DOCS=(
  "docs/INSTALL.md"
  "docs/USAGE.md"
  "docs/interface-cdx.md"
)
declare -a RUNNER_DOCS=(
  "docs/auth-runner.md"
  "runner/README.md"
)

collect_repo_files() {
  local repo_dir="$1"
  local prefix="$2"
  local -n tracked_ref="$3"
  local -n warnings_ref="$4"

  if [[ ! -d "${repo_dir}" ]]; then
    warnings_ref+=("Missing repo directory: ${repo_dir}")
    return
  fi
  if ! git -C "${repo_dir}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warnings_ref+=("Not a git work tree: ${repo_dir}")
    return
  fi

  local path
  while IFS= read -r path; do
    if [[ -n "${prefix}" ]]; then
      tracked_ref+=("${prefix}${path}")
    else
      tracked_ref+=("${path}")
    fi
  done < <(git -C "${repo_dir}" ls-files)
}

is_secret_file() {
  local path="$1"
  case "${path}" in
    .env|*/.env) return 0 ;;
    .env.*|*/.env.*)
      case "${path}" in
        .env.example|*/.env.example|.env.sample|*/.env.sample) return 1 ;;
      esac
      return 0
      ;;
    *.pem|*.key|*.p12|*.pfx|*.crt|*.csr|*.sqlite|*.sqlite3) return 0 ;;
    storage/*.log) return 0 ;;
  esac
  return 1
}

is_path_excluded() {
  local path="$1"
  case "${path}" in
    .git/*|*/.git/*) return 0 ;;
    vendor/*|*/vendor/*) return 0 ;;
    storage/*|*/storage/*) return 0 ;;
    docs/img/*|*/docs/img/*) return 0 ;;
    runner/__pycache__/*) return 0 ;;
    public/admin/assets/chart.umd.min.js) return 0 ;;
    public/admin/assets/chartjs-plugin-zoom.min.js) return 0 ;;
    public/admin/assets/hammer.min.js) return 0 ;;
  esac

  case "${path}" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.svg|*.pdf|*.pyc|*.phar|*.zip|*.tar|*.gz|*.woff2|*.ttf)
      return 0
      ;;
  esac
  return 1
}

is_test_path() {
  local path="$1"
  case "${path}" in
    tests/*) return 0 ;;
    *) return 1 ;;
  esac
}

should_include_by_extension() {
  local path="$1"
  local base="${path##*/}"

  case "${base}" in
    Dockerfile|docker-compose.yml|composer.json|composer.lock|phpunit.xml.dist|phpstan.neon.dist|phpstan-baseline.neon|Caddyfile)
      return 0
      ;;
  esac

  case "${path}" in
    *.php|*.sql|*.js|*.css|*.json|*.xml|*.yml|*.yaml|*.sh|*.py|*.html|*.conf|*.caddy|*.neon|*.htaccess)
      return 0
      ;;
  esac

  return 1
}

language_hint() {
  local path="$1"
  local base="${path##*/}"
  case "${path}" in
    *.php) echo "php"; return 0 ;;
    *.sql) echo "sql"; return 0 ;;
    *.js) echo "javascript"; return 0 ;;
    *.css) echo "css"; return 0 ;;
    *.json) echo "json"; return 0 ;;
    *.xml) echo "xml"; return 0 ;;
    *.yml|*.yaml) echo "yaml"; return 0 ;;
    *.sh) echo "bash"; return 0 ;;
    *.py) echo "python"; return 0 ;;
    *.html) echo "html"; return 0 ;;
    *.conf|*.caddy) echo "conf"; return 0 ;;
    *.neon) echo "yaml"; return 0 ;;
    *.htaccess) echo "apacheconf"; return 0 ;;
    *.md|*.MD) echo "markdown"; return 0 ;;
    *.txt) echo "text"; return 0 ;;
    *) ;;
  esac

  case "${base}" in
    Dockerfile) echo "dockerfile" ;;
    docker-compose.yml) echo "yaml" ;;
    composer.json|composer.lock) echo "json" ;;
    phpunit.xml.dist) echo "xml" ;;
    phpstan.neon.dist|phpstan-baseline.neon) echo "yaml" ;;
    Caddyfile) echo "caddyfile" ;;
    *) echo "text" ;;
  esac
}

default_output_path_for_component() {
  local component="$1"
  printf '%s/codex-orchestrator-%s-%s-%s.txt' \
    "${DEFAULT_OUTPUT_DIR}" \
    "${component}" \
    "${bundle_date}" \
    "${bundle_time}"
}

should_include_component_file() {
  local component="$1"
  local path="$2"

  case "${component}" in
    app)
      case "${path}" in
        composer.json|composer.lock|Dockerfile|docker-compose.yml|phpunit.xml.dist|phpstan.neon.dist|phpstan-baseline.neon) return 0 ;;
        caddy/*|public/*|src/*|scripts/*.php|tests/*) return 0 ;;
      esac
      ;;
    wrapper)
      case "${path}" in
        composer.json|composer.lock|docker-compose.yml|scripts/*.sh) return 0 ;;
        wrappers/*) return 0 ;;
        public/cli-auth-verify.html|public/admin/assets/cli-auth-verify.js) return 0 ;;
        src/Http/InstallerHelper.php|src/Http/VersionHelper.php) return 0 ;;
        src/Http/Controllers/CliAuthController.php|src/Http/Controllers/ConfigApiController.php|src/Http/Controllers/HostApiController.php|src/Http/Controllers/InstallV2Controller.php|src/Http/Controllers/WrapperV2Controller.php) return 0 ;;
        src/Services/AgentsService.php|src/Services/ClientConfigService.php|src/Services/CliAuthService.php|src/Services/SkillService.php|src/Services/StartupSyncService.php|src/Services/WrapperService.php) return 0 ;;
        src/Services/Wrapper/V2/*) return 0 ;;
        src/Support/CodexVersionPolicy.php|src/Support/Installation.php) return 0 ;;
        tests/WrapperV2*|tests/InstallationTest.php|tests/StartupSync*) return 0 ;;
      esac
      ;;
    runner)
      case "${path}" in
        runner/*) return 0 ;;
        src/Adapters/*|src/Contracts/BackendAdapter.php) return 0 ;;
        src/Http/Controllers/OpenAiApiController.php|src/Http/OpenAiCompat.php|src/Http/OpenAiResponse.php) return 0 ;;
        src/Repositories/OpenaiApiKeyRepository.php) return 0 ;;
        src/Services/AuthService.php|src/Services/OpenAiModelService.php|src/Services/OpenaiApiKeyService.php|src/Services/RunnerValidationService.php|src/Services/RunnerVerifier.php) return 0 ;;
        tests/AdminSkillGenerationUiTest.php|tests/AuthRunner*|tests/AuthServiceContractResponsesTest.php|tests/AuthServiceMcpCredentialMockTest.php|tests/AuthServiceRunnerStoreGateTest.php|tests/OpenAi*|tests/Runner*|tests/SkillDraftServiceTest.php|tests/SkillSummaryServiceTest.php) return 0 ;;
      esac
      ;;
  esac

  return 1
}

export_bundle_for_component() {
  local component="$1"
  local output_path="$2"

  local -a warnings=()
  local -a secret_excluded=()
  local -a tracked=()
  collect_repo_files "${ROOT_DIR}" "" tracked warnings

  if ((${#tracked[@]} == 0)); then
    die "No tracked files found for component '${component}'."
  fi

  local -a tracked_sorted=()
  mapfile -t tracked_sorted < <(printf '%s\n' "${tracked[@]}" | LC_ALL=C sort -u)

  local -a canonical_docs=("${COMMON_DOCS[@]}")
  case "${component}" in
    app) canonical_docs+=("${APP_DOCS[@]}") ;;
    wrapper) canonical_docs+=("${WRAPPER_DOCS[@]}") ;;
    runner) canonical_docs+=("${RUNNER_DOCS[@]}") ;;
    *) die "Internal error: unsupported component '${component}'" ;;
  esac

  local -A canonical_doc_set=()
  local doc
  for doc in "${canonical_docs[@]}"; do
    canonical_doc_set["${doc}"]=1
    if [[ ! -f "${ROOT_DIR}/${doc}" ]]; then
      warnings+=("Canonical doc missing: ${doc}")
    fi
  done

  local -a selected_files=()
  local path
  for path in "${tracked_sorted[@]}"; do
    if [[ -n "${canonical_doc_set[${path}]:-}" ]]; then
      selected_files+=("${path}")
      continue
    fi

    if is_secret_file "${path}"; then
      secret_excluded+=("${path}")
      continue
    fi

    case "${path}" in
      *.md|*.MD|*.txt|*.rst)
        continue
        ;;
    esac

    if is_path_excluded "${path}"; then
      continue
    fi

    if (( INCLUDE_TESTS == 0 )) && is_test_path "${path}"; then
      continue
    fi

    if should_include_component_file "${component}" "${path}" && should_include_by_extension "${path}"; then
      selected_files+=("${path}")
    fi
  done

  if ((${#selected_files[@]} == 0)); then
    die "Selection is empty after filtering for component '${component}'."
  fi

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
    size="$(wc -c < "${full_path}")"
    total_bytes=$((total_bytes + size))
  done

  {
    echo "===== AI BUNDLE EXPORT ====="
    echo "SCRIPT_VERSION: ${SCRIPT_VERSION}"
    echo "GENERATED_AT_UTC: ${timestamp}"
    echo "WORKSPACE_ROOT: ${ROOT_DIR}"
    echo "COMPONENT: ${component}"
    if (( INCLUDE_TESTS )); then
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
    echo "Tracked files from this git repo only."
    echo "Canonical docs included explicitly."
    echo "Code/config selected by component scope plus extension allowlist."
    echo
    echo "===== EXCLUDE POLICY ====="
    echo "Secrets: .env, key material, sqlite artifacts, runtime logs."
    echo "Artifacts/noise: vendor/, storage/, docs/img/, __pycache__, fonts, minified vendor assets, binary/media files."
    echo "Non-canonical markdown/txt docs excluded."
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
      if [[ ! -f "${full_path}" ]]; then
        continue
      fi
      size="$(wc -c < "${full_path}")"
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
  } > "${tmp_output}"

  mv "${tmp_output}" "${output_path}"
  WRITTEN_OUTPUTS+=("${output_path}")
  WRITTEN_OUTPUT_SET["${output_path}"]=1

  echo "Wrote AI bundle (${component}):"
  echo "  ${output_path}"
  echo "Files: ${#selected_files[@]}  Bytes: ${total_bytes}  Excluded secrets: ${#secret_excluded[@]}"
}

cleanup_export_files() {
  local directory="$1"
  [[ -d "${directory}" ]] || return 0

  local -a removed=()
  local base_name full_path
  while IFS= read -r base_name; do
    if [[ ! "${base_name}" =~ ^codex-orchestrator-(app|wrapper|runner)-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}_[0-9]{2}\.txt$ ]]; then
      continue
    fi
    full_path="${directory}/${base_name}"
    if [[ -n "${WRITTEN_OUTPUT_SET[${full_path}]:-}" ]]; then
      continue
    fi
    rm -f -- "${full_path}"
    removed+=("${full_path}")
  done < <(find "${directory}" -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort)

  if ((${#removed[@]} == 0)); then
    return 0
  fi

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
  components_to_export=(app wrapper runner)
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

  component_name=""
  for component_name in "${components_to_export[@]}"; do
    component_output="${output_dir}/codex-orchestrator-${component_name}-${bundle_date}-${bundle_time}.txt"
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

cleanup_dir=""
for cleanup_dir in "${!cleanup_dirs[@]}"; do
  cleanup_export_files "${cleanup_dir}"
done

echo "Export complete. Bundles written: ${#WRITTEN_OUTPUTS[@]}"
echo "Old export files removed: ${CLEANUP_TOTAL_REMOVED}"
