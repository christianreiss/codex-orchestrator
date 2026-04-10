<?php

declare(strict_types=1);

namespace App\Services;

use InvalidArgumentException;

class ClaudeModelService
{
    public const SUPPORTED_MODELS = [
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
    ];

    public const DEFAULT_MODEL = 'claude-sonnet-4-6';

    /** @return list<string> */
    public function supportedModels(): array
    {
        return self::SUPPORTED_MODELS;
    }

    public function defaultModel(): string
    {
        return self::DEFAULT_MODEL;
    }

    public function resolveRequestedModel(mixed $value): string
    {
        $normalized = is_string($value) ? trim($value) : '';
        if ($normalized !== '') {
            if (in_array($normalized, self::SUPPORTED_MODELS, true)) {
                return $normalized;
            }

            throw new InvalidArgumentException(sprintf(
                'Unsupported model "%s". Supported models: %s',
                $normalized,
                implode(', ', self::SUPPORTED_MODELS)
            ));
        }

        return self::DEFAULT_MODEL;
    }
}
