<?php

declare(strict_types=1);

namespace App\Support;

final class Engine
{
    public const CODEX = 'codex';
    public const CLAUDE = 'claude';

    public const KEY_PREFIX = [
        self::CODEX => 'sk-codex-',
        self::CLAUDE => 'sk-claude-',
    ];

    public static function keyPrefix(string $engine): string
    {
        return self::KEY_PREFIX[$engine] ?? self::KEY_PREFIX[self::CODEX];
    }

    public static function logPrefix(string $engine): string
    {
        return $engine === self::CLAUDE ? 'claude.key' : 'openai.key';
    }
}
