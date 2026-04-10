<?php

declare(strict_types=1);

namespace App\Services;

use App\Repositories\ClientConfigRepository;
use App\Repositories\VersionRepository;
use InvalidArgumentException;

class OpenAiModelService
{
    public const DEFAULT_MODEL = ConfigNormalizer::FORCE_UPGRADE_MODEL;

    public function __construct(
        private readonly ClientConfigRepository $configs,
        private readonly VersionRepository $versions
    ) {
    }

    /**
     * @return list<string>
     */
    public function supportedModels(): array
    {
        return ConfigNormalizer::supportedModels();
    }

    public function defaultModel(): ?string
    {
        $row = $this->configs->latest();
        $settings = is_array($row['settings'] ?? null) ? $row['settings'] : [];
        $configModel = ConfigNormalizer::normalizeStoredModel($settings['model'] ?? null);
        if ($configModel !== null) {
            return $configModel;
        }

        return ConfigNormalizer::normalizeStoredModel($this->versions->get('cdx_model'));
    }

    public function resolveRequestedModel(mixed $value): string
    {
        $normalized = is_string($value) ? trim($value) : '';
        if ($normalized !== '') {
            $model = ConfigNormalizer::normalizeSupportedModel($normalized);
            if ($model !== null) {
                return $model;
            }

            $lowered = strtolower($normalized);
            if (isset(ConfigNormalizer::LEGACY_MODEL_UPGRADES[$lowered])) {
                return ConfigNormalizer::LEGACY_MODEL_UPGRADES[$lowered];
            }

            throw new InvalidArgumentException(sprintf(
                'Unsupported model "%s". Supported models: %s',
                $normalized,
                implode(', ', $this->supportedModels())
            ));
        }

        $default = $this->defaultModel();
        if ($default !== null) {
            return $default;
        }

        return self::DEFAULT_MODEL;
    }
}
