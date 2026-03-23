<?php

namespace App\Http;

use App\Config;
use App\Repositories\VersionRepository;
use App\Services\AuthService;

final class VersionHelper
{
    public static function normalizeVersionValue(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $value = trim($value);

        return $value === '' ? null : $value;
    }

    public static function normalizeBoolean(mixed $value): ?bool
    {
        if (is_bool($value)) {
            return $value;
        }

        if (is_int($value)) {
            if ($value === 1) {
                return true;
            }
            if ($value === 0) {
                return false;
            }
        }

        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if ($normalized === '1' || $normalized === 'true' || $normalized === 'yes' || $normalized === 'on') {
                return true;
            }
            if ($normalized === '0' || $normalized === 'false' || $normalized === 'no' || $normalized === 'off') {
                return false;
            }
        }

        return null;
    }

    public static function normalizeReverseDnsModeInput(mixed $value): ?string
    {
        if ($value === null) {
            return 'global';
        }
        if (is_bool($value)) {
            return $value ? 'enabled' : 'disabled';
        }
        if (is_int($value)) {
            return $value !== 0 ? 'enabled' : 'disabled';
        }
        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if ($normalized === '' || $normalized === 'global' || $normalized === 'default') {
                return 'global';
            }
            if (in_array($normalized, ['1', 'true', 'yes', 'on', 'enabled', 'enable'], true)) {
                return 'enabled';
            }
            if (in_array($normalized, ['0', 'false', 'no', 'off', 'disabled', 'disable'], true)) {
                return 'disabled';
            }
        }

        return null;
    }

    public static function formatReverseDnsModeOutput(mixed $value): string
    {
        if ($value === null) {
            return 'global';
        }
        if (is_bool($value)) {
            return $value ? 'enabled' : 'disabled';
        }
        if (is_int($value)) {
            return $value !== 0 ? 'enabled' : 'disabled';
        }
        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if ($normalized === 'enabled' || $normalized === 'disabled' || $normalized === 'global') {
                return $normalized;
            }
            if ($normalized === '1' || $normalized === 'true' || $normalized === 'yes' || $normalized === 'on') {
                return 'enabled';
            }
            if ($normalized === '0' || $normalized === 'false' || $normalized === 'no' || $normalized === 'off') {
                return 'disabled';
            }
        }

        return 'global';
    }

    public static function quotaLimitPercent(VersionRepository $versionRepository): int
    {
        $raw = $versionRepository->get('quota_limit_percent');
        $normalized = AuthService::normalizeQuotaLimitPercent($raw);
        return $normalized ?? AuthService::DEFAULT_QUOTA_LIMIT_PERCENT;
    }

    public static function quotaWeekPartition(VersionRepository $versionRepository): int
    {
        $raw = $versionRepository->get('quota_week_partition');
        $normalized = AuthService::normalizeQuotaWeekPartition($raw);
        return $normalized ?? AuthService::DEFAULT_QUOTA_WEEK_PARTITION;
    }

    public static function modelUsesSparkQuotaLane(?string $model): ?bool
    {
        if (!is_string($model)) {
            return null;
        }

        $trimmed = strtolower(trim($model));
        if ($trimmed === '') {
            return null;
        }

        return str_contains($trimmed, 'spark');
    }

    public static function resolveActiveQuotaLaneForHost(array $host, VersionRepository $versionRepository, mixed $fallback = null): string
    {
        $hostLanePreference = AuthService::normalizeQuotaLane($host['lane_preference'] ?? null);
        if ($hostLanePreference !== null) {
            return $hostLanePreference;
        }

        $hostModelSpark = self::modelUsesSparkQuotaLane($host['model_override'] ?? null);
        if ($hostModelSpark !== null) {
            return $hostModelSpark ? 'spark' : 'normal';
        }

        $globalModelSpark = self::modelUsesSparkQuotaLane($versionRepository->get('cdx_model'));
        if ($globalModelSpark !== null) {
            return $globalModelSpark ? 'spark' : 'normal';
        }

        $fallbackLane = AuthService::normalizeQuotaLane($fallback);
        if ($fallbackLane !== null) {
            return $fallbackLane;
        }

        return 'normal';
    }

    public static function inactivityWindowDays(VersionRepository $versionRepository): int
    {
        $stored = $versionRepository->get('inactivity_window_days');
        if (is_numeric($stored)) {
            $value = (int) $stored;
        } else {
            $raw = Config::get('INACTIVITY_WINDOW_DAYS', 30);
            $value = is_numeric($raw) ? (int) $raw : 30;
        }

        if ($value < 0) {
            $value = 0;
        } elseif ($value > 60) {
            $value = 60;
        }

        return $value;
    }

    public static function extractClientVersion(mixed $payload): ?string
    {
        if (is_array($payload) && array_key_exists('client_version', $payload)) {
            $value = self::normalizeVersionValue($payload['client_version']);
            if ($value !== null) {
                return $value;
            }
        }

        $aliases = ['client_version', 'cdx_version'];
        foreach ($aliases as $alias) {
            $fromQuery = RequestHelper::resolveQueryParam($alias);
            if ($fromQuery !== null) {
                return $fromQuery;
            }
        }

        return null;
    }

    public static function extractWrapperVersion(mixed $payload): ?string
    {
        if (is_array($payload) && array_key_exists('wrapper_version', $payload)) {
            $value = self::normalizeVersionValue($payload['wrapper_version']);
            if ($value !== null) {
                return $value;
            }
        }

        $fromQuery = RequestHelper::resolveQueryParam('wrapper_version');
        if ($fromQuery !== null) {
            return $fromQuery;
        }

        return null;
    }
}
