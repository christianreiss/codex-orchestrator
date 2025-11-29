<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 */

namespace App\Support;

use DateTimeImmutable;

class Timestamp
{
    public static function compare(?string $first, ?string $second): int
    {
        if ($first === null && $second === null) {
            return 0;
        }

        if ($first === null) {
            return -1;
        }

        if ($second === null) {
            return 1;
        }

        $firstTime = self::fromString($first);
        $secondTime = self::fromString($second);

        if (!$firstTime || !$secondTime) {
            // Fallback to lexical comparison if parsing fails.
            return strcmp($first, $second);
        }

        if ($firstTime == $secondTime) {
            return 0;
        }

        return $firstTime > $secondTime ? 1 : -1;
    }

    private static function fromString(string $value): ?DateTimeImmutable
    {
        $value = trim($value);
        if ($value === '') {
            return null;
        }

        if (preg_match('/\.(\d+)Z$/', $value, $match)) {
            $micro = substr(str_pad($match[1], 6, '0'), 0, 6);
            $value = preg_replace('/\.(\d+)Z$/', '.' . $micro . 'Z', $value);
        } elseif (str_ends_with($value, 'Z')) {
            $value = str_replace('Z', '.000000Z', $value);
        }

        try {
            return new DateTimeImmutable($value);
        } catch (\Exception) {
            return null;
        }
    }
}
