<?php

namespace App\Http;

use App\Config;

final class RequestHelper
{
    public static function resolveQueryParam(string $key): ?string
    {
        if (!isset($_GET[$key])) {
            return null;
        }

        return VersionHelper::normalizeVersionValue($_GET[$key]);
    }

    public static function resolveIntQuery(string $key): ?int
    {
        if (!isset($_GET[$key])) {
            return null;
        }

        if (is_array($_GET[$key])) {
            return null;
        }

        $filtered = filter_var($_GET[$key], FILTER_VALIDATE_INT);
        if ($filtered === false) {
            return null;
        }

        return (int) $filtered;
    }

    public static function resolveStringQuery(string $key): ?string
    {
        if (!isset($_GET[$key])) {
            return null;
        }

        if (is_array($_GET[$key])) {
            return null;
        }

        $value = trim((string) $_GET[$key]);
        return $value === '' ? null : $value;
    }

    public static function resolveApiKey(): ?string
    {
        $header = $_SERVER['HTTP_X_API_KEY'] ?? null;
        if ($header) {
            return $header;
        }

        $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? null;
        if ($authorization && str_starts_with($authorization, 'Bearer ')) {
            return substr($authorization, 7);
        }

        return null;
    }

    public static function resolveRequestScheme(): string
    {
        if (TrustedProxy::forwardedHeadersTrusted($_SERVER)) {
            $forwardedProto = $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '';
            if (is_string($forwardedProto) && trim($forwardedProto) !== '') {
                $schemeCandidate = explode(',', $forwardedProto)[0] ?? '';
                return strtolower(trim((string) $schemeCandidate)) === 'https' ? 'https' : 'http';
            }
        }

        if (!empty($_SERVER['REQUEST_SCHEME']) && is_string($_SERVER['REQUEST_SCHEME'])) {
            return strtolower($_SERVER['REQUEST_SCHEME']) === 'https' ? 'https' : 'http';
        }

        return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    }

    public static function resolveRequestHost(): string
    {
        if (TrustedProxy::forwardedHeadersTrusted($_SERVER)) {
            $forwardedHostHeader = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? '';
            if (is_string($forwardedHostHeader) && trim($forwardedHostHeader) !== '') {
                return trim((string) (explode(',', $forwardedHostHeader)[0] ?? ''));
            }
        }

        $hostHeader = $_SERVER['HTTP_HOST'] ?? '';
        if (is_string($hostHeader) && trim($hostHeader) !== '') {
            return trim($hostHeader);
        }

        $serverName = $_SERVER['SERVER_NAME'] ?? '';
        if (is_string($serverName)) {
            return trim($serverName);
        }

        return '';
    }

    public static function resolveBaseUrl(): string
    {
        $candidates = [];

        $envBase = Config::get('PUBLIC_BASE_URL', '');
        if (is_string($envBase) && trim($envBase) !== '') {
            $candidates[] = $envBase;
        }

        $hostCandidate = self::resolveRequestHost();
        $scheme = self::resolveRequestScheme();

        if ($hostCandidate !== '') {
            $candidates[] = sprintf('%s://%s', $scheme, trim($hostCandidate));
        }

        $serverName = $_SERVER['SERVER_NAME'] ?? '';
        if ($serverName !== '' && $serverName !== $hostCandidate) {
            $candidates[] = sprintf('%s://%s', $scheme, $serverName);
        }

        foreach ($candidates as $candidate) {
            $normalized = self::normalizeBaseUrlCandidate($candidate);
            if ($normalized !== '') {
                return $normalized;
            }
        }

        return '';
    }

    public static function normalizeBaseUrlCandidate(string $value): string
    {
        $trimmed = rtrim(trim($value), '/');
        if ($trimmed === '') {
            return '';
        }

        if (!preg_match('#^https?://[A-Za-z0-9._~:-]+(?:/.*)?$#', $trimmed)) {
            return '';
        }

        return $trimmed;
    }

    public static function enforcePublicBaseUrlPolicy(string $path): void
    {
        $publicBase = self::normalizeBaseUrlCandidate((string) Config::get('PUBLIC_BASE_URL', ''));
        if (self::publicBaseUrlRequired() && $publicBase === '') {
            Response::json([
                'status' => 'error',
                'message' => 'PUBLIC_BASE_URL is required in this environment',
                'data' => [
                    'app_env' => EnvironmentHelper::runtimeEnvironment(),
                    'required' => true,
                ],
            ], 503);
        }

        if (!self::strictHostValidationEnabled() || $publicBase === '' || self::isHostValidationBypassPath($path)) {
            return;
        }

        if (!self::requestHostMatchesPublicBaseUrl($publicBase)) {
            Response::json([
                'status' => 'error',
                'message' => 'Request host does not match PUBLIC_BASE_URL',
                'data' => [
                    'expected' => parse_url($publicBase, PHP_URL_HOST),
                    'received' => parse_url('http://' . self::resolveRequestHost(), PHP_URL_HOST),
                ],
            ], 400);
        }
    }

    public static function publicBaseUrlRequired(): bool
    {
        $default = EnvironmentHelper::isProductionEnvironment();
        $value = VersionHelper::normalizeBoolean(Config::get('PUBLIC_BASE_URL_REQUIRED', $default ? '1' : '0'));
        return $value ?? $default;
    }

    public static function strictHostValidationEnabled(): bool
    {
        $default = EnvironmentHelper::isProductionEnvironment();
        $value = VersionHelper::normalizeBoolean(Config::get('STRICT_HOST_VALIDATION', $default ? '1' : '0'));
        return $value ?? $default;
    }

    public static function isHostValidationBypassPath(string $path): bool
    {
        if (str_starts_with($path, '/install/')) {
            return true;
        }
        if (str_starts_with($path, '/seed/auth/')) {
            return true;
        }

        return false;
    }

    public static function requestHostMatchesPublicBaseUrl(string $publicBase): bool
    {
        $expectedHost = parse_url($publicBase, PHP_URL_HOST);
        if (!is_string($expectedHost) || trim($expectedHost) === '') {
            return true;
        }

        $expectedPortRaw = parse_url($publicBase, PHP_URL_PORT);
        $expectedScheme = parse_url($publicBase, PHP_URL_SCHEME);
        $expectedPort = is_int($expectedPortRaw)
            ? $expectedPortRaw
            : (strtolower((string) $expectedScheme) === 'https' ? 443 : 80);

        $requestHost = self::resolveRequestHost();
        if ($requestHost === '') {
            return false;
        }

        $parsed = parse_url('http://' . $requestHost);
        if (!is_array($parsed) || !isset($parsed['host'])) {
            return false;
        }

        $requestPort = isset($parsed['port']) && is_numeric($parsed['port'])
            ? (int) $parsed['port']
            : (self::resolveRequestScheme() === 'https' ? 443 : 80);

        if (strtolower((string) $parsed['host']) !== strtolower($expectedHost)) {
            return false;
        }

        return $requestPort === $expectedPort;
    }

    public static function resolveClientIp(): ?string
    {
        return ClientIp::fromServer($_SERVER);
    }
}
