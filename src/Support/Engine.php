<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Supported AI engines that a host can run.
 *
 * A host may have one or both engines installed. The engine determines
 * which wrapper (cdx / clx), auth format, config format, and CLI binary
 * is used on that host.
 */
final class Engine
{
    public const CODEX = 'codex';
    public const CLAUDE = 'claude';

    /** All valid engine identifiers. */
    public const ALL = [self::CODEX, self::CLAUDE];

    /** Default engine for backwards compatibility. */
    public const DEFAULT = self::CODEX;

    /** API key prefixes per engine. */
    public const KEY_PREFIX = [
        self::CODEX  => 'sk-codex-',
        self::CLAUDE => 'sk-claude-',
    ];

    /** Wrapper binary names per engine. */
    public const WRAPPER_NAME = [
        self::CODEX  => 'cdx',
        self::CLAUDE => 'clx',
    ];

    /** Agents document filenames per engine. */
    public const AGENTS_DOCUMENT = [
        self::CODEX  => 'AGENTS.md',
        self::CLAUDE => 'CLAUDE.md',
    ];

    /** Config format per engine. */
    public const CONFIG_FORMAT = [
        self::CODEX  => 'toml',
        self::CLAUDE => 'json',
    ];

    /** Config filename per engine. */
    public const CONFIG_FILE = [
        self::CODEX  => 'config.toml',
        self::CLAUDE => 'settings.json',
    ];

    /** CLI binary names per engine. */
    public const CLI_BINARY = [
        self::CODEX  => 'codex',
        self::CLAUDE => 'claude',
    ];

    /** Runner verify endpoints per engine. */
    public const RUNNER_VERIFY_PATH = [
        self::CODEX  => '/verify',
        self::CLAUDE => '/verify-claude',
    ];

    public static function isValid(string $engine): bool
    {
        return in_array($engine, self::ALL, true);
    }

    public static function validate(string $engine): string
    {
        if (!self::isValid($engine)) {
            throw new \InvalidArgumentException(
                sprintf('Invalid engine "%s". Must be one of: %s', $engine, implode(', ', self::ALL))
            );
        }
        return $engine;
    }

    /**
     * Parse a comma-separated engine list from a host record.
     *
     * @return string[] Non-empty array of valid engine identifiers.
     */
    public static function parseHostEngines(?string $value): array
    {
        if ($value === null || trim($value) === '') {
            return [self::DEFAULT];
        }

        $engines = array_filter(
            array_map('trim', explode(',', $value)),
            fn (string $e): bool => self::isValid($e)
        );

        return $engines !== [] ? array_values(array_unique($engines)) : [self::DEFAULT];
    }

    /**
     * Serialize an engine list for storage.
     *
     * @param string[] $engines
     */
    public static function serializeHostEngines(array $engines): string
    {
        $valid = array_filter($engines, fn (string $e): bool => self::isValid($e));
        $unique = array_unique($valid);
        sort($unique);
        return implode(',', $unique);
    }

    /**
     * Check if a host's engine list includes a specific engine.
     */
    public static function hostHasEngine(?string $hostEngines, string $engine): bool
    {
        return in_array($engine, self::parseHostEngines($hostEngines), true);
    }

    /**
     * Get the appropriate API key prefix for an engine.
     */
    public static function keyPrefix(string $engine): string
    {
        return self::KEY_PREFIX[$engine] ?? self::KEY_PREFIX[self::DEFAULT];
    }

    /**
     * Detect engine from an API key prefix.
     */
    public static function fromApiKeyPrefix(string $apiKey): string
    {
        foreach (self::KEY_PREFIX as $engine => $prefix) {
            if (str_starts_with($apiKey, $prefix)) {
                return $engine;
            }
        }
        return self::DEFAULT;
    }

    /**
     * Get the wrapper binary name for an engine.
     */
    public static function wrapperName(string $engine): string
    {
        return self::WRAPPER_NAME[$engine] ?? self::WRAPPER_NAME[self::DEFAULT];
    }

    /**
     * Detect engine from a wrapper name.
     */
    public static function fromWrapperName(string $wrapper): string
    {
        $map = array_flip(self::WRAPPER_NAME);
        return $map[$wrapper] ?? self::DEFAULT;
    }

    /**
     * Get the agents document filename for an engine.
     */
    public static function agentsDocument(string $engine): string
    {
        return self::AGENTS_DOCUMENT[$engine] ?? self::AGENTS_DOCUMENT[self::DEFAULT];
    }

    /**
     * Get the config filename for an engine.
     */
    public static function configFile(string $engine): string
    {
        return self::CONFIG_FILE[$engine] ?? self::CONFIG_FILE[self::DEFAULT];
    }

    /**
     * Get the CLI binary name for an engine.
     */
    public static function cliBinary(string $engine): string
    {
        return self::CLI_BINARY[$engine] ?? self::CLI_BINARY[self::DEFAULT];
    }

    public static function logPrefix(string $engine): string
    {
        return $engine === self::CLAUDE ? 'claude.key' : 'openai.key';
    }
}
