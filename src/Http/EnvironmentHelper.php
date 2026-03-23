<?php

namespace App\Http;

use App\Config;

final class EnvironmentHelper
{
    public static function runtimeEnvironment(): string
    {
        $raw = Config::get('APP_ENV', 'development');
        if (!is_string($raw)) {
            return 'development';
        }

        $normalized = strtolower(trim($raw));
        if ($normalized === 'prod') {
            return 'production';
        }

        return $normalized !== '' ? $normalized : 'development';
    }

    public static function isProductionEnvironment(): bool
    {
        return self::runtimeEnvironment() === 'production';
    }

    public static function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
