<?php

declare(strict_types=1);

namespace App\Support;

final class AdminTheme
{
    /** @var list<string> */
    public const OPTIONS = ['auto', 'auto-pink', 'light', 'dark', 'bright-pink', 'dark-pink'];

    public static function normalize(mixed $value): string
    {
        if (!is_string($value)) {
            return 'auto';
        }

        $normalized = trim(strtolower($value));

        return in_array($normalized, self::OPTIONS, true) ? $normalized : 'auto';
    }

    public static function isPink(mixed $value): bool
    {
        $normalized = self::normalize($value);

        return $normalized === 'auto-pink' || $normalized === 'bright-pink' || $normalized === 'dark-pink';
    }
}
