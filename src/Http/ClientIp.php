<?php

namespace App\Http;

final class ClientIp
{
    public static function fromServer(array $server): ?string
    {
        $sanitize = static function (mixed $candidate): ?string {
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
        };

        $real = $sanitize($server['HTTP_X_REAL_IP'] ?? null);
        if ($real !== null) {
            return $real;
        }

        $xff = $server['HTTP_X_FORWARDED_FOR'] ?? null;
        if (is_string($xff) && trim($xff) !== '') {
            $parts = array_filter(array_map('trim', explode(',', $xff)));
            foreach ($parts as $part) {
                $ip = $sanitize($part);
                if ($ip !== null) {
                    return $ip;
                }
            }
        }

        return $sanitize($server['REMOTE_ADDR'] ?? null);
    }
}

