<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperCronBehaviorTest extends TestCase
{
    public function testCronInstallUsesManagedMarkerAndEscapedCommand(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString("cron_managed_marker() {\n  printf '%s' '# cdx-managed-cron'", $wrapperSource);
        self::assertStringContainsString("printf -v quoted_cdx_path '%q' \"\$cdx_path\"", $wrapperSource);
        self::assertStringContainsString("printf -v quoted_log_file '%q' \"\$log_file\"", $wrapperSource);
        self::assertStringContainsString('cron_command="${cron_command//%/\\\\%}"', $wrapperSource);
        self::assertStringContainsString("printf 'cdx cron job installed (daily at %02d:%02d). Log: %s\\n'", $wrapperSource);
        self::assertStringContainsString('if cron_ping_check_api "cron install"; then', $wrapperSource);
        self::assertStringContainsString("cdx cron install pinged /cron/check successfully.", $wrapperSource);
        self::assertStringContainsString('CRON_CHECK_RESPONSE="$check_response"', $wrapperSource);
    }

    public function testCronModeUsesPortableLockFallbackWithoutFlockAndRequiresReportSuccess(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('exec 9>"$lock_file" || {', $wrapperSource);
        self::assertStringContainsString('local lock_dir_fallback="${lock_file}.d"', $wrapperSource);
        self::assertStringContainsString('elif mkdir "$lock_dir_fallback" 2>/dev/null; then', $wrapperSource);
        self::assertStringContainsString('trap \'rmdir "$lock_dir_fallback" 2>/dev/null || true\' RETURN', $wrapperSource);
        self::assertStringNotContainsString('log_warn "flock not available; cron concurrent-run guard disabled."', $wrapperSource);
        self::assertStringContainsString('cron: update report failed after retries', $wrapperSource);
        self::assertStringContainsString('for report_attempt in 1 2 3; do', $wrapperSource);
        self::assertStringContainsString("'wrapper_version': '\${WRAPPER_VERSION:-unknown}'", $wrapperSource);
        self::assertStringContainsString('primary.verify_flags &= ~ssl.VERIFY_X509_STRICT', $wrapperSource);
        self::assertStringContainsString('fallback.verify_flags &= ~ssl.VERIFY_X509_STRICT', $wrapperSource);
        self::assertStringContainsString('contexts.append(ssl._create_unverified_context())', $wrapperSource);
    }

    public function testWrapperReconcilesCronInstallationToMatchServerPolicy(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('cron_wrapper_entry_installed() {', $wrapperSource);
        self::assertStringContainsString('cron_build_check_payload() {', $wrapperSource);
        self::assertStringContainsString('cron_ping_check_api() {', $wrapperSource);
        self::assertStringContainsString('fetch_release_payload() {', $wrapperSource);
        self::assertStringContainsString('perform_update() (', $wrapperSource);
        self::assertStringContainsString("API_RELEASES_URL=\"https://api.github.com/repos/openai/codex/releases\"\n\nif ((CODEX_CRON_MODE)); then", $wrapperSource);
        self::assertStringContainsString("wrapper_action=\"\$(printf '%s' \"\$check_response\"", $wrapperSource);
        self::assertStringContainsString('if [[ "$wrapper_action" == "update" ]]; then', $wrapperSource);
        self::assertStringContainsString('perform_wrapper_self_update "$wrapper_target_version" "$wrapper_target_sha" "$wrapper_target_url"', $wrapperSource);
        self::assertStringContainsString('exec env CODEX_WRAPPER_RESTARTED=1 "$SCRIPT_REAL" --cron', $wrapperSource);
        self::assertStringContainsString('CRON_CHECK_RESPONSE=""', $wrapperSource);
        self::assertStringContainsString('CRON_CHECK_RESPONSE="$check_response"', $wrapperSource);
        self::assertStringContainsString('reconcile_cron_job_state() {', $wrapperSource);
        self::assertStringContainsString('if [[ "${SYNC_REMOTE_AUTO_UPDATE_CRON:-}" == "1" ]]; then', $wrapperSource);
        self::assertStringContainsString('if reconcile_cron_job_state install; then', $wrapperSource);
        self::assertStringContainsString('AUTO_UPDATE_CRON_READY=1', $wrapperSource);
        self::assertStringContainsString(
            'Cron-managed auto-update is enabled by the server, but the wrapper could not ensure the cron job; falling back to startup Codex update checks.',
            $wrapperSource
        );
        self::assertStringContainsString('reconcile_cron_job_state remove || log_warn', $wrapperSource);
        self::assertStringContainsString('elif [[ "${SYNC_REMOTE_AUTO_UPDATE_CRON:-}" == "1" ]] && ((AUTO_UPDATE_CRON_READY)); then', $wrapperSource);
    }

    public function testCronModeResolvesCodexStateBeforeReleaseLookup(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('local codex_bin local_version_raw local_version cron_asset_name', $wrapperSource);
        self::assertStringContainsString('codex_bin="$(resolve_real_codex 2>/dev/null || true)"', $wrapperSource);
        self::assertStringContainsString("cron: codex binary not found on PATH.", $wrapperSource);
        self::assertStringContainsString('local_version="$(normalize_version "$local_version_raw")"', $wrapperSource);
        self::assertStringContainsString('cron_asset_name="$(detect_codex_asset_name 2>/dev/null)" || true', $wrapperSource);
        self::assertStringContainsString("cron: unsupported platform; cannot determine Codex asset name.", $wrapperSource);
        self::assertStringContainsString('if [[ -z "$wrapper_target_url" ]] && [[ -n "${CODEX_SYNC_BASE_URL:-}" ]]; then', $wrapperSource);
        self::assertStringContainsString('wrapper_target_url="${CODEX_SYNC_BASE_URL%/}/wrapper/download"', $wrapperSource);
        self::assertStringContainsString('wrapper_target_url="${CODEX_SYNC_BASE_URL%/}${wrapper_target_url}"', $wrapperSource);
        self::assertStringContainsString('if payload_json="$(fetch_release_payload "${api_releases_url}/tags/${tag_variant}" "$cron_asset_name" 2>/dev/null)"; then', $wrapperSource);
        self::assertStringContainsString('if perform_update "$codex_bin" "$remote_url" "${remote_asset:-$cron_asset_name}" "$target_version" "$remote_sha256"; then', $wrapperSource);
    }

    public function testReleaseAssetLookupFailsClosedWhenSpecificAssetMissing(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('if asset is None and not wanted:', $wrapperSource);
        self::assertStringContainsString('error: could not find release asset {wanted}', $wrapperSource);
    }
}
