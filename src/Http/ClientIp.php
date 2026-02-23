<?php

namespace App\Http;

final class ClientIp
{
    public static function fromServer(array $server): ?string
    {
        if (TrustedProxy::forwardedHeadersTrusted($server)) {
            $real = TrustedProxy::sanitizeIp($server['HTTP_X_REAL_IP'] ?? null);
            if ($real !== null) {
                return $real;
            }

            $xff = $server['HTTP_X_FORWARDED_FOR'] ?? null;
            if (is_string($xff) && trim($xff) !== '') {
                $parts = array_filter(array_map('trim', explode(',', $xff)));
                foreach ($parts as $part) {
                    $ip = TrustedProxy::sanitizeIp($part);
                    if ($ip !== null) {
                        return $ip;
                    }
                }
            }
        }

        return TrustedProxy::sanitizeIp($server['REMOTE_ADDR'] ?? null);
    }
}
