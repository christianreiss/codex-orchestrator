<?php

declare(strict_types=1);

namespace App\Support;

final class CodexVersionPolicy
{
    public const MINIMUM_VERSION = '0.114.0';

    public static function minimumVersion(): string
    {
        return self::MINIMUM_VERSION;
    }

    public static function normalize(?string $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $normalized = trim($value);
        $normalized = preg_replace('/^(codex-cli|codex|rust-)\s*/i', '', $normalized) ?? $normalized;
        $normalized = trim($normalized);
        $normalized = ltrim($normalized, 'vV');

        return $normalized === '' ? null : $normalized;
    }

    public static function isSemanticVersion(?string $value): bool
    {
        $normalized = self::normalize($value);

        return is_string($normalized) && preg_match('/^\d+\.\d+\.\d+$/', $normalized) === 1;
    }

    /**
     * @return array{version:string, enforce_exact:bool}
     */
    public static function resolveEffective(?string $value, bool $exactRequested): array
    {
        $minimum = self::minimumVersion();
        $normalized = self::normalize($value);

        if ($normalized === null || !self::isSemanticVersion($normalized)) {
            return [
                'version' => $minimum,
                'enforce_exact' => false,
            ];
        }

        if (version_compare($normalized, $minimum, '<=')) {
            return [
                'version' => $minimum,
                'enforce_exact' => false,
            ];
        }

        return [
            'version' => $normalized,
            'enforce_exact' => $exactRequested,
        ];
    }
}
