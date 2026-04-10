<?php

declare(strict_types=1);

namespace App\Support;

final class InstallerMode
{
    public const CODEX = Engine::CODEX;
    public const CLAUDE = Engine::CLAUDE;
    public const BOTH = 'both';

    public const ALL = [
        self::CODEX,
        self::CLAUDE,
        self::BOTH,
    ];

    /**
     * @param string[] $engines
     */
    public static function forHostEngines(array $engines): string
    {
        $normalized = Engine::serializeHostEngines($engines);
        if ($normalized === Engine::CODEX . ',' . Engine::CLAUDE) {
            return self::BOTH;
        }
        if ($normalized === Engine::CLAUDE) {
            return self::CLAUDE;
        }

        return self::CODEX;
    }

    public static function normalize(?string $value): string
    {
        $candidate = is_string($value) ? strtolower(trim($value)) : '';

        return in_array($candidate, self::ALL, true) ? $candidate : self::CODEX;
    }

    public static function label(string $mode): string
    {
        return match (self::normalize($mode)) {
            self::CLAUDE => 'Claude',
            self::BOTH => 'Codex + Claude',
            default => 'Codex',
        };
    }
}
