<?php

declare(strict_types=1);

namespace App\Services;

use App\Repositories\VersionRepository;
use InvalidArgumentException;

class ClaudeModelService
{
    public const SUPPORTED_MODELS = [
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
    ];

    public const DEFAULT_MODEL = 'claude-sonnet-4-6';

    public function __construct(
        private readonly ?VersionRepository $versions = null,
    ) {
    }

    /** @return list<string> */
    public function supportedModels(): array
    {
        return self::SUPPORTED_MODELS;
    }

    public function defaultModel(): string
    {
        if ($this->versions !== null) {
            $configured = $this->versions->get('claude_default_model');
            $normalized = self::normalizeSupportedModel($configured);
            if ($normalized !== null) {
                return $normalized;
            }
        }

        return self::DEFAULT_MODEL;
    }

    /**
     * Validate and normalize a model identifier against the supported list.
     * Returns the model if supported, null otherwise.
     */
    public static function normalizeSupportedModel(mixed $value): ?string
    {
        if (!is_string($value) && !is_numeric($value)) {
            return null;
        }
        $model = strtolower(trim((string) $value));
        if ($model === '') {
            return null;
        }

        return in_array($model, self::SUPPORTED_MODELS, true) ? $model : null;
    }

    public function resolveRequestedModel(mixed $value): string
    {
        $normalized = is_string($value) ? trim($value) : '';
        if ($normalized !== '') {
            $model = self::normalizeSupportedModel($normalized);
            if ($model !== null) {
                return $model;
            }

            throw new InvalidArgumentException(sprintf(
                'Unsupported model "%s". Supported models: %s',
                $normalized,
                implode(', ', self::SUPPORTED_MODELS)
            ));
        }

        return $this->defaultModel();
    }
}
