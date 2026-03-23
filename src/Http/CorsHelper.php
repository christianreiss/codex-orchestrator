<?php

namespace App\Http;

use App\Config;

final class CorsHelper
{
    public static function normalizeOrigin(?string $origin): ?string
    {
        if ($origin === null || $origin === '') {
            return null;
        }

        $parsed = parse_url($origin);
        if (!is_array($parsed) || !isset($parsed['scheme'], $parsed['host'])) {
            return null;
        }

        $normalized = strtolower((string) $parsed['scheme']) . '://' . strtolower((string) $parsed['host']);
        if (isset($parsed['port'])) {
            $normalized .= ':' . (int) $parsed['port'];
        }

        return $normalized;
    }

    public static function allowedOrigins(): array
    {
        $origins = [];

        $configured = Config::get('MCP_ALLOWED_ORIGINS');
        if (is_string($configured) && trim($configured) !== '') {
            foreach (explode(',', $configured) as $piece) {
                $normalized = self::normalizeOrigin(trim($piece));
                if ($normalized !== null) {
                    $origins[] = $normalized;
                }
            }
        }

        $base = Config::get('PUBLIC_BASE_URL');
        $baseOrigin = self::normalizeOrigin(is_string($base) ? $base : null);
        if ($baseOrigin !== null) {
            $origins[] = $baseOrigin;
        }

        $allowRequestHostOrigin = VersionHelper::normalizeBoolean(Config::get('MCP_ALLOW_REQUEST_HOST_ORIGIN', '0')) ?? false;
        if ($allowRequestHostOrigin) {
            $requestOrigin = self::resolveRequestOrigin();
            if ($requestOrigin !== null) {
                $origins[] = $requestOrigin;
            }
        }

        return array_values(array_unique($origins));
    }

    public static function isOriginAllowed(?string $origin): bool
    {
        if ($origin === null || $origin === '') {
            return true;
        }

        $normalized = self::normalizeOrigin($origin);
        if ($normalized === null) {
            return false;
        }

        foreach (self::allowedOrigins() as $candidate) {
            if ($candidate === $normalized) {
                return true;
            }
        }

        return false;
    }

    public static function resolveRequestOrigin(): ?string
    {
        $host = RequestHelper::resolveRequestHost();
        if ($host === '') {
            return null;
        }

        return self::normalizeOrigin(RequestHelper::resolveRequestScheme() . '://' . $host);
    }
}
