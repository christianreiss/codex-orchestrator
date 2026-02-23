<?php

namespace App\Http;

use App\Config;

final class TrustedProxy
{
    /**
     * @param array<string,mixed> $server
     */
    public static function forwardedHeadersTrusted(array $server): bool
    {
        $trustFlag = self::normalizeBool(Config::get('TRUST_X_FORWARDED', '0'));
        if ($trustFlag !== true) {
            return false;
        }

        $remoteIp = self::sanitizeIp($server['REMOTE_ADDR'] ?? null);
        if ($remoteIp === null) {
            return false;
        }

        $cidrs = self::parseCidrs((string) Config::get('TRUSTED_PROXY_CIDRS', ''));
        if ($cidrs === []) {
            return false;
        }

        return self::ipMatchesAnyCidr($remoteIp, $cidrs);
    }

    public static function sanitizeIp(mixed $candidate): ?string
    {
        if (!is_string($candidate)) {
            return null;
        }

        $candidate = trim($candidate);
        if ($candidate === '') {
            return null;
        }

        // Proxies sometimes provide IP:port or [ipv6]:port; strip port and validate IP.
        if ($candidate[0] === '[') {
            $end = strpos($candidate, ']');
            if ($end !== false) {
                $candidate = substr($candidate, 1, $end - 1);
            }
        } else {
            $colonCount = substr_count($candidate, ':');
            if ($colonCount === 1 && str_contains($candidate, '.')) {
                $candidate = explode(':', $candidate, 2)[0];
            }
        }

        $candidate = trim($candidate);
        if ($candidate === '') {
            return null;
        }

        return filter_var($candidate, FILTER_VALIDATE_IP) ? $candidate : null;
    }

    /**
     * @param list<string> $cidrs
     */
    public static function ipMatchesAnyCidr(string $ip, array $cidrs): bool
    {
        foreach ($cidrs as $cidr) {
            if (self::ipMatchesCidr($ip, $cidr)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @return list<string>
     */
    public static function parseCidrs(string $raw): array
    {
        if (trim($raw) === '') {
            return [];
        }

        $result = [];
        foreach (explode(',', $raw) as $part) {
            $candidate = trim($part);
            if ($candidate === '') {
                continue;
            }
            $result[] = $candidate;
        }

        return $result;
    }

    private static function normalizeBool(mixed $value): ?bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value === 1 ? true : ($value === 0 ? false : null);
        }
        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
                return true;
            }
            if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) {
                return false;
            }
        }

        return null;
    }

    private static function ipMatchesCidr(string $ip, string $cidr): bool
    {
        $slashPos = strpos($cidr, '/');
        if ($slashPos === false) {
            $candidate = self::sanitizeIp($cidr);
            return $candidate !== null && $candidate === $ip;
        }

        $network = trim(substr($cidr, 0, $slashPos));
        $prefixRaw = trim(substr($cidr, $slashPos + 1));
        if ($network === '' || $prefixRaw === '' || !ctype_digit($prefixRaw)) {
            return false;
        }

        $ipBin = inet_pton($ip);
        $networkBin = inet_pton($network);
        if ($ipBin === false || $networkBin === false || strlen($ipBin) !== strlen($networkBin)) {
            return false;
        }

        $maxPrefix = strlen($ipBin) * 8;
        $prefix = (int) $prefixRaw;
        if ($prefix < 0 || $prefix > $maxPrefix) {
            return false;
        }

        $fullBytes = intdiv($prefix, 8);
        $remainingBits = $prefix % 8;

        if ($fullBytes > 0) {
            if (substr($ipBin, 0, $fullBytes) !== substr($networkBin, 0, $fullBytes)) {
                return false;
            }
        }

        if ($remainingBits === 0) {
            return true;
        }

        $mask = (0xFF << (8 - $remainingBits)) & 0xFF;
        $ipByte = ord($ipBin[$fullBytes]);
        $networkByte = ord($networkBin[$fullBytes]);

        return ($ipByte & $mask) === ($networkByte & $mask);
    }
}

