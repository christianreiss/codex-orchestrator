<?php

declare(strict_types=1);

namespace App\Services;

use App\Repositories\ClientConfigRepository;
use App\Repositories\VersionRepository;
use InvalidArgumentException;

class ClaudeModelService
{
    public const DEFAULT_MODEL = 'claude-sonnet-4-6';

    /** @var list<string> */
    public const SUPPORTED_MODELS = ConfigNormalizer::CLAUDE_SUPPORTED_MODELS;

    /** @var array<string, string> */
    public const LEGACY_MODEL_UPGRADES = ConfigNormalizer::CLAUDE_LEGACY_MODEL_UPGRADES;

    public function __construct(
        private readonly ClientConfigRepository $configs,
        private readonly VersionRepository $versions,
    ) {
    }

    /** @return list<string> */
    public function supportedModels(): array
    {
        return self::SUPPORTED_MODELS;
    }

    public function defaultModel(): string
    {
        $row = $this->configs->latest();
        $settings = is_array($row['settings'] ?? null) ? $row['settings'] : [];
        $configModel = self::normalizeSupportedModel($settings['claude_model'] ?? $settings['model'] ?? null);
        if ($configModel !== null) {
            return $configModel;
        }

        $configured = $this->versions->get('claude_default_model');
        $normalized = self::normalizeSupportedModel($configured);
        if ($normalized !== null) {
            return $normalized;
        }

        return self::DEFAULT_MODEL;
    }

    public function resolveRequestedModel(mixed $value): string
    {
        $normalized = is_string($value) ? trim($value) : '';
        if ($normalized !== '') {
            $model = self::normalizeSupportedModel($normalized);
            if ($model !== null) {
                return $model;
            }

            $lowered = strtolower($normalized);
            if (isset(self::LEGACY_MODEL_UPGRADES[$lowered])) {
                return self::LEGACY_MODEL_UPGRADES[$lowered];
            }

            throw new InvalidArgumentException(sprintf(
                'Unsupported model "%s". Supported models: %s',
                $normalized,
                implode(', ', self::SUPPORTED_MODELS)
            ));
        }

        return $this->defaultModel();
    }

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

    public static function normalizeStoredModel(mixed $value): ?string
    {
        $supported = self::normalizeSupportedModel($value);
        if ($supported !== null) {
            return $supported;
        }

        if (!is_string($value) && !is_numeric($value)) {
            return null;
        }
        $model = strtolower(trim((string) $value));
        if ($model === '') {
            return null;
        }

        return self::LEGACY_MODEL_UPGRADES[$model] ?? null;
    }
}
